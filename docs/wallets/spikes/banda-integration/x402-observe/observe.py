"""
The smallest addon that answers the question: can banda's egress proxy record a 402 challenge as an observation of the
server it actually reached over verified TLS, and hand the box only an id? It pins the tunnel's address as banda's
addon does (connect to the resolved IP, keep the TLS name), and in `responseheaders` records a 402's PAYMENT-REQUIRED
with the tunnel's host and the path, adding `x-banda-challenge: <id>` to the response the box gets.
"""
import json, secrets, socket
from mitmproxy import ctx

class Observe:
    def __init__(self):
        self.tunnel = {}

    def load(self, loader):
        ctx.options.connection_strategy = "lazy"
        ctx.options.upstream_cert = False

    def http_connect(self, flow):
        host, port = flow.request.host, flow.request.port
        address = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)[0][4][0]
        self.tunnel[flow.client_conn.id] = (host, port, address)
        flow.request.host = address  # pinned: the TLS name stays the client's SNI

    def request(self, flow):
        host, port, address = self.tunnel[flow.client_conn.id]
        named = flow.request.host_header
        flow.request.host = address
        flow.request.host_header = named

    def responseheaders(self, flow):
        if flow.response.status_code != 402:
            return
        host, port, address = self.tunnel[flow.client_conn.id]
        challenge = secrets.token_hex(12)
        record = {
            "id": challenge,
            "scheme": flow.request.scheme,
            "host": host,
            "port": port,
            "sni": flow.client_conn.sni,
            "server_address": list(flow.server_conn.peername or []),
            "server_sni": flow.server_conn.sni,
            "path": flow.request.path,
            "method": flow.request.method,
            "payment_required": flow.response.headers.get("payment-required"),
        }
        with open("/out/observations.jsonl", "a") as handle:
            handle.write(json.dumps(record) + "\n")
        flow.response.headers["x-banda-challenge"] = challenge

addons = [Observe()]
