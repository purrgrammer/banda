"""
The proxy's addon (proxy/addon.py) run on the host, without mitmproxy: a stand-in for the few mitmproxy names it uses,
and requests made by hand, each admitted as the proxy would. Reads cases (JSON) on stdin and prints, per case, what
happened: the status it was refused with and its body, or that it went on, with the headers it went on with; and what
the proxy's state holds after (held tickets, writes sent).

argv: the proxy's directory, a state directory (empty), the config (JSON)
"""

import base64
import json
import os
import sys
import types

proxy_dir, state_dir, config = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
os.environ["BANDA_STATE"] = state_dir
os.environ["BANDA_KEPT"] = os.path.join(state_dir, "kept-volume")


class Headers:
    def __init__(self, pairs):
        self.pairs = [(k, v) for k, v in pairs]

    def get(self, key, default=None):
        for k, v in self.pairs:
            if k.lower() == key.lower():
                return v
        return default

    def get_all(self, key):
        return [v for k, v in self.pairs if k.lower() == key.lower()]

    def items(self, multi=False):
        return list(self.pairs)

    def pop(self, key, default=None):
        found = self.get(key, default)
        self.pairs = [(k, v) for k, v in self.pairs if k.lower() != key.lower()]
        return found

    def __setitem__(self, key, value):
        self.pop(key)
        self.pairs.append((key, value))

    def __delitem__(self, key):
        self.pop(key)


class Response:
    def __init__(self, status, body, headers):
        self.status_code, self.body, self.headers = status, body, headers
        self.stream = None

    @staticmethod
    def make(status, body, headers):
        return Response(status, body, headers)


mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.ctx = types.SimpleNamespace(options=types.SimpleNamespace())
mitmproxy.http = types.SimpleNamespace(Response=Response)
sys.modules["mitmproxy"] = mitmproxy
sys.path.insert(0, proxy_dir)

import addon  # noqa: E402
import policy  # noqa: E402
import state  # noqa: E402

state.write_json(state.path("config.json"), config)
# every name is public here: the forge's address stands for any host
addon.resolve = lambda host, port: ["93.184.216.34"]


class Request:
    def __init__(self, case):
        self.method = case["method"]
        self.scheme = case.get("scheme", "https")
        self.host = case["host"]
        self.port = case.get("port", 443 if self.scheme == "https" else 80)
        self.path = case.get("path", "/")
        self.host_header = case["host"]
        self.headers = Headers(case.get("headers", []))
        self.raw_content = case.get("body", "").encode()
        self.is_http2 = case.get("http", 1) == 2
        self.is_http3 = case.get("http", 1) == 3

    @property
    def url(self):
        return f"{self.scheme}://{self.host_header}{self.path}"


egress = addon.Egress()
out = []
for n, case in enumerate(json.load(sys.stdin)):
    user = case["login"]
    password = policy.mark(config["key"], user)
    auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    flow = types.SimpleNamespace(
        request=Request({**case, "headers": [*case.get("headers", []), ["Proxy-Authorization", auth]]}),
        response=None,
        metadata={},
        client_conn=types.SimpleNamespace(id=f"client{n}", sni=None),
        server_conn=types.SimpleNamespace(timestamp_tcp_setup=None),
        error=None,
    )
    egress.request(flow)
    if flow.response is not None:
        out.append({"status": flow.response.status_code, "body": flow.response.body.decode()})
    else:
        out.append({"on": True, "headers": flow.request.headers.items()})
        # what its server does, as the case says: answers (200 unless it names a status), or the connection fails
        if "fails" in case:
            flow.server_conn.timestamp_tcp_setup = 1.0 if case.get("reached") else None
            flow.error = types.SimpleNamespace(msg=case["fails"])
            egress.error(flow)
        else:
            response = case.get("response", {})
            flow.response = Response(case.get("answer", 200), b"", Headers(response.get("headers", [])))
            killed = []
            flow.kill = lambda: killed.append(True)
            egress.responseheaders(flow)
            if "response" in case:
                body = base64.b64decode(response.get("body", ""))
                if flow.response.stream is not None and not killed:
                    split = response.get("split", len(body) // 2)
                    chunks = [chunk for chunk in [body[:split], body[split:]] if chunk]
                    body = b"".join(
                        piece
                        for chunk in [*chunks, b""]
                        for piece in flow.response.stream(chunk)
                    )
                out[-1]["response"] = {
                    "headers": flow.response.headers.items(),
                    "body": base64.b64encode(body).decode(),
                    "streamed": flow.response.stream is not None,
                    "killed": bool(killed),
                }
        # a WebSocket the case opens: whether it streams, and what each frame its server sends arrives as
        if "frames" in case:
            killed = []
            flow.kill = lambda: killed.append(True)
            flow.websocket = types.SimpleNamespace(messages=[])
            egress.websocket_start(flow)
            arrived = []
            for frame in case["frames"] if not killed else []:
                message = types.SimpleNamespace(from_client=False, content=frame.encode())
                flow.websocket.messages.append(message)
                egress.websocket_message(flow)
                arrived.append(message.content.decode())
            out[-1]["streams"] = not killed
            out[-1]["frames"] = arrived
    egress.client_disconnected(flow.client_conn)


def records(kind):
    found = {}
    root = state.kept(kind)
    for chat in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        found[chat] = [state.read_json(os.path.join(root, chat, f), None) for f in sorted(os.listdir(os.path.join(root, chat)))]
    return found


print(json.dumps({"cases": out, "held": records("held"), "sent": records("sent")}))
