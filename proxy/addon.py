"""
The egress proxy's addon (DESIGN.md "The box", Network): every request from the box passes here, and only here.

- A request names its chat by its proxy login, a mark only the daemon can make; without one it is refused.
- The host is resolved once and pinned: the connection goes to that address, so a name cannot answer differently later.
  A request is aimed at its pinned address before mitmproxy picks its connection, so the next request to the same host
  goes on the same connection.
  Loopback, private ranges, link-local and metadata addresses, and banda's own port are refused, in every spelling.
- Inside a tunnel, a request whose Host or TLS name names another server than the tunnel's is refused.
- A read passes to a public host, noted as its chat's. A git fetch (a POST to upload-pack) to a forge the daemon
  names is a read.
- A write (any method but GET, HEAD and OPTIONS, a WebSocket upgrade) is held as a ticket and answered 403: the daemon
  takes it into its store, and the proxy sends it only when the owner approved it (the control script's replay).
  A write to a host the owner allowed for the agent its chat runs (the daemon's config names them by chat) goes
  straight through, recorded for the daemon before it is sent and its outcome noted after, unless it carries a
  credential of its own (the floor). A WebSocket opened there streams: its opening is the write recorded, its frames
  pass, and what the server sends is scrubbed of credentials. Every other WebSocket is cut.
- Credentials the daemon gave for a host are set at the proxy, never in the box, and scrubbed from what comes back;
  none on a request that acts as nobody (web_fetch's reads).
- Anything that is not HTTP (raw TCP in a tunnel) is cut.
- The box's browser has a login of its own, which the daemon maps to the chat holding the browser, and
  whether the owner holds it: its reads go to any public host (what a page loads is the page's; the daemon gates what
  the agent puts into a page), its writes wait in the browser itself, and one reaches here only once the owner approved
  it (a pass for its exact bytes) or while the owner holds the browser. It gets no credential: its session is its own.
"""

import base64
import binascii
import socket

from mitmproxy import ctx, http

import policy
import state

# The most a body may weigh: a response streams through, so this bounds a download (a toolchain, a release's binary),
# never the proxy's memory; a request is read whole (a held write is stored whole), so it has a limit of its own.
BODY_LIMIT = 4 * 1024 * 1024 * 1024
REQUEST_LIMIT = 16 * 1024 * 1024


def resolve(host, port):
    return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def refuse(flow, status, why, headers=None):
    flow.response = http.Response.make(
        status,
        f"banda: {why}\n".encode(),
        {"content-type": "text/plain; charset=utf-8", **(headers or {})},
    )


class Browser(str):
    """The login of an agent's browser: the agent's id. Its requests are its holder's, looked up at each request."""


def login(headers):
    """The chat a Proxy-Authorization header names, a `Browser` for an agent's browser's login, or None."""
    value = headers.get("proxy-authorization", "")
    scheme, _, encoded = value.partition(" ")
    if scheme.lower() != "basic":
        return None
    try:
        username, _, password = base64.b64decode(encoded).decode().partition(":")
    except (binascii.Error, UnicodeDecodeError):
        return None
    key = state.config().get("key")
    if key is None:
        return None
    agent = policy.browser_login(username, password, key)
    if agent is not None:
        return Browser(agent)
    return policy.identity(username, password, key)


TAB_HEADER = "x-banda-tab"
# A request that acts as nobody (web_fetch's reads): no credential is set on it. The box can only ever give one up by
# it, never gain one, so it is taken from whatever sends it.
NOBODY_HEADER = "x-banda-as-nobody"


def tab_holder(agent, stamp, key):
    """
    The chat a request of `agent`'s browser is, by the stamp its tab set (`<chat>.<mark>`, marked by the daemon), and
    whether the owner holds that tab; None when the stamp is missing, forged, or names a chat with no tab there now.
    """
    chat = policy.tab_chat(stamp, key, agent)
    if chat is None:
        return None
    tabs = ((state.config().get("browsers") or {}).get(agent) or {}).get("tabs") or {}
    tab = tabs.get(str(chat))
    if tab is None:
        return None
    return chat, bool(tab.get("owner"))


def held(flow, chat, host, port):
    """A request as it is held: whole, and whose it is."""
    return {
        "chat": chat,
        "method": flow.request.method,
        "scheme": flow.request.scheme,
        "host": host,
        "port": port,
        "path": flow.request.path,
        "headers": [[k, v] for k, v in flow.request.headers.items(multi=True)],
        "body": base64.b64encode(flow.request.raw_content or b"").decode(),
    }


class Egress:
    def __init__(self):
        # per client connection: its chat, and the tunnel it opened
        self.who = {}
        self.tunnel = {}
        # per client connection, (host, port): the address it was pinned to
        self.pins = {}

    def load(self, loader):
        ctx.options.connection_strategy = "lazy"
        ctx.options.upstream_cert = False
        ctx.options.http3 = False
        ctx.options.stream_large_bodies = None
        ctx.options.body_size_limit = str(BODY_LIMIT)

    def client_disconnected(self, client):
        self.who.pop(client.id, None)
        self.tunnel.pop(client.id, None)
        for key in [key for key in self.pins if key[0] == client.id]:
            del self.pins[key]

    def _pin(self, flow, host, port):
        address, why = policy.pin(host, port, resolve, state.config().get("daemonPort"))
        if why is not None:
            refuse(flow, 403, why)
            return False
        self.pins[(flow.client_conn.id, host, port)] = address
        return True

    def http_connect(self, flow):
        chat = login(flow.request.headers)
        if chat is None:
            refuse(flow, 407, "this proxy needs banda's login", {"proxy-authenticate": 'Basic realm="banda"'})
            return
        self.who[flow.client_conn.id] = chat
        host, port = policy.name(flow.request.host), flow.request.port
        self.tunnel[flow.client_conn.id] = (host, port)
        if self._pin(flow, host, port):
            # the tunnel's server is its pinned address from the start; its TLS name is still the one the client sent
            flow.request.host = self.pins[(flow.client_conn.id, host, port)]

    def requestheaders(self, flow):
        # what a request says it weighs, refused before its body is read; one that does not say is cut at the limit
        declared = flow.request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > REQUEST_LIMIT:
            refuse(flow, 413, f"this request's body is larger than the proxy takes ({REQUEST_LIMIT} bytes)")

    def request(self, flow):
        target = self._admit(flow)
        if target is not None and flow.response is None:
            self._aim(flow, *target)

    def _aim(self, flow, host, port):
        """
        Send `flow` to `host`'s pinned address, named as the client named it. mitmproxy reuses a server connection only
        for a request naming that connection's address, and holds at most five open to one address per client
        connection: a request still naming the host would get a new connection each time, kept open, until the sixth
        waited forever. Named by its address, every request to the host goes on the one connection.
        """
        named = flow.request.host_header
        flow.request.host = self.pins[(flow.client_conn.id, host, port)]
        flow.request.host_header = named

    def _admit(self, flow):
        """Whether `flow` goes on, as `(host, port)`, the server it names; None when it was refused."""
        client = flow.client_conn.id
        tunnel = self.tunnel.get(client)
        if tunnel is None:
            # a plain request: it names its chat itself, and its server by its URL
            chat = login(flow.request.headers)
            if chat is None:
                refuse(flow, 407, "this proxy needs banda's login", {"proxy-authenticate": 'Basic realm="banda"'})
                return None
            host, port = policy.name(flow.request.host), flow.request.port
            why = policy.same_server(host, flow.request.host_header, hosts=flow.request.headers.get_all("host"))
            if why is not None or not self._pin(flow, host, port):
                if why is not None:
                    refuse(flow, 403, why)
                return None
        else:
            chat = self.who.get(client)
            host, port = tunnel
            why = policy.same_server(
                host, flow.request.host_header, flow.client_conn.sni, flow.request.headers.get_all("host")
            )
            if why is not None:
                refuse(flow, 403, why)
                return None
            if (client, host, port) not in self.pins:
                refuse(flow, 403, "this tunnel was not allowed")
                return None
        flow.request.headers.pop("proxy-authorization", None)
        flow.request.headers.pop("proxy-connection", None)
        nobody = flow.request.headers.pop(NOBODY_HEADER, None) is not None
        writes = policy.is_write(flow.request.method, flow.request.headers.items(multi=True), flow.request.url)
        if isinstance(chat, Browser):
            self._browser(flow, str(chat), host, port, writes)
            return host, port
        flow.metadata["banda"] = {"chat": chat, "host": host, "port": port, "nobody": nobody}
        if writes and policy.git_fetch(
            host,
            flow.request.method,
            flow.request.headers.items(multi=True),
            flow.request.url,
            flow.request.raw_content,
            state.config().get("git", []),
        ):
            # a git fetch to a forge the daemon named reads, as a GET does; the browser's requests never are one
            writes = False
        if chat == 0:
            # nobody's chat, the daemon listing a server, reads as any chat does; it never writes
            if writes:
                refuse(flow, 403, "nobody's chat only reads")
                return None
            self._credentials(flow, host)
            return host, port
        cfg = state.config()
        headers = flow.request.headers.items(multi=True)
        scheme = flow.request.scheme
        # the hosts the owner allowed for the agent this chat runs, as the daemon names them by chat; nothing the box says
        by_chat = cfg.get("permitted") or {}
        permitted = by_chat.get(str(chat), []) if isinstance(by_chat, dict) else []
        if writes and policy.direct_write(scheme, host, port, headers, flow.request.path, permitted):
            # a host the owner allowed takes this chat's writes as they happen: recorded before it is sent, so the
            # daemon logs every one; what comes back is foreign
            body = flow.request.raw_content or b""
            record = {"method": flow.request.method, "scheme": scheme, "host": host, "port": port}
            record["path"] = flow.request.path
            record["hash"] = policy.write_hash(flow.request.method, host, port, flow.request.path, body)
            record["bytes"] = len(body)
            flow.metadata["banda"]["sent"] = state.sent(chat, record)
            flow.metadata["banda"]["stream"] = policy.is_websocket(headers)
            self._credentials(flow, host)
            return host, port
        if writes:
            ticket = state.hold(chat, held(flow, chat, host, port))
            refuse(
                flow,
                403,
                policy.held_words(ticket, scheme, host, port, headers, flow.request.path),
                {"x-banda-ticket": ticket},
            )
            return None
        state.read(chat, host)
        self._credentials(flow, host)
        return host, port

    def _browser(self, flow, agent, host, port, writes):
        # whose this request is: the chat its tab stamped, at this request (a tunnel is every tab's); the stamp never
        # leaves the proxy
        stamp = flow.request.headers.get(TAB_HEADER, "")
        flow.request.headers.pop(TAB_HEADER, None)
        holder = tab_holder(agent, stamp, state.config().get("key"))
        if holder is None:
            refuse(flow, 403, f"this request is no tab's of {agent}'s browser")
            return
        chat, owner = holder
        flow.metadata["banda"] = {"chat": chat, "host": host, "port": port, "browser": True}
        if writes:
            digest = policy.write_hash(flow.request.method, host, port, flow.request.path, flow.request.raw_content)
            if owner or state.passes(chat, digest):
                return
            ticket = state.hold(chat, held(flow, chat, host, port))
            refuse(flow, 403, f"this request writes, so it waits for the owner: ticket {ticket}. It has not been sent.", {"x-banda-ticket": ticket})
            return
        state.read(chat, host)

    def _credentials(self, flow, host):
        if flow.metadata.get("banda", {}).get("nobody"):
            return
        for header, value in policy.credential_for(host, state.config().get("credentials", []), flow.request.scheme):
            flow.request.headers[header] = value

    def server_connect(self, data):
        # a request was aimed at its pinned address; anything else connects nowhere
        address, port = data.server.address
        client = data.client.id
        if not any(c == client and p == port and a == address for (c, _, p), a in self.pins.items()):
            data.server.error = "banda: this server was not pinned"

    def responseheaders(self, flow):
        if flow.response is None or flow.metadata.get("banda") is None:
            return
        sent = flow.metadata["banda"].get("sent")
        if sent is not None:
            # a write sent under a host permission is logged with what its server answered
            state.outcome(flow.metadata["banda"]["chat"], sent, {"status": flow.response.status_code})
        credentials = state.config().get("credentials", [])
        # its headers go before its body: a credential they echo is scrubbed now
        for key, value in list(flow.response.headers.items(multi=True)):
            cleaned = policy.scrub(value.encode(), credentials).decode()
            if cleaned != value:
                flow.response.headers[key] = cleaned
        # every body streams, any size, never held whole: undone from its encoding and scrubbed as it passes, so a
        # credential inside a compressed body is found too
        encoding = flow.response.headers.get("content-encoding", "")
        decode = policy.decoder(encoding)
        if decode is None:
            flow.kill()
            return
        if flow.response.status_code == 101:
            # a protocol switch has no body: what follows is the stream's, scrubbed frame by frame
            return
        bodiless = flow.request.method.upper() == "HEAD" or flow.response.status_code in (204, 304)
        if encoding.strip().lower() not in ("", "identity") and not bodiless:
            # it goes on as sent, of a length nobody knows until its end
            del flow.response.headers["content-encoding"]
            flow.response.headers.pop("content-length", None)
            if not (flow.request.is_http2 or flow.request.is_http3):
                flow.response.headers["transfer-encoding"] = "chunked"
        scrub = policy.scrubber(credentials)

        def stream(chunk):
            out = scrub(decode(chunk)) if chunk else scrub(decode(b"")) + scrub(b"")
            # nothing to send is no chunk: an empty one, framed for HTTP/1, would end the body
            return [out] if out else []

        flow.response.stream = stream

    def error(self, flow):
        meta = flow.metadata.get("banda") or {}
        if meta.get("sent") is None:
            return
        # no answer: whether it reached its server says whether any of it may have gone
        server = getattr(flow, "server_conn", None)
        reached = server is not None and getattr(server, "timestamp_tcp_setup", None) is not None
        why = str(flow.error.msg if flow.error is not None else "the connection failed")
        state.outcome(meta["chat"], meta["sent"], {"failed": why, "reached": reached})

    def websocket_start(self, flow):
        # only a WebSocket opened as a write the owner allowed, recorded as it opened, streams
        if not (flow.metadata.get("banda") or {}).get("stream"):
            flow.kill()

    def websocket_message(self, flow):
        message = flow.websocket.messages[-1]
        if message.from_client:
            return
        cleaned = policy.scrub(message.content, state.config().get("credentials", []))
        if cleaned != message.content:
            message.content = cleaned

    def tcp_start(self, flow):
        flow.kill()

    def udp_start(self, flow):
        flow.kill()


addons = [Egress()]
