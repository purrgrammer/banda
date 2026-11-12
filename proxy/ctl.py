"""
How the daemon talks to the proxy, over `docker exec` alone (never through the box):

- `config`: the daemon's config from stdin, refused when older than the one held (its generation, its login key, the
  forges whose git fetches read, its port, credentials, each chat's allowed hosts).
- `take <chat>`: the requests held for it, the writes sent under a host permission, and the hosts it read.
- `sent`: the chats with writes sent under a host permission not yet taken, for the daemon's sweep.
- `ack <chat> <read bytes> [ticket or sent id...]`: forget what the daemon stored.
- `pass <chat> <hash>`: let one write the owner approved in the browser through, by its hash.
- `replay`: send one held request (stdin), exactly as held, to the address it resolves to now, if that is public;
  credentials set, the response scrubbed. Prints the response.
"""

import base64
import http.client
import json
import os
import socket
import ssl
import sys

import certifi

import policy
import state

RESPONSE_LIMIT = 1024 * 1024


def configure(value):
    """
    Take the daemon's config, unless the proxy holds a later one: a generation never goes back, so a push that lost a
    race cannot restore what a later one took away. `{"stale": <held>}` when refused.
    """
    with state.locked():
        held = state.read_json(state.path("config.json"), {}).get("generation", 0)
        if not isinstance(value.get("generation"), int) or value["generation"] < held:
            return {"stale": held}
        state.write_json(state.path("config.json"), value)
    return {}


def _records(kind, chat):
    folder = state.kept(kind, chat)
    found = []
    for entry in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if entry.endswith(".json"):
            found.append(state.read_json(os.path.join(folder, entry), None))
    return [record for record in found if record is not None]


def take(chat):
    with state.locked():
        held = _records("held", chat)
        sent = sorted(_records("sent", chat), key=lambda record: record.get("at", 0))
        try:
            with open(state.kept("reads", chat), "rb") as handle:
                reads = handle.read()
        except FileNotFoundError:
            reads = b""
    hosts = sorted(set(reads.decode().split()))
    return {"held": held, "sent": sent, "reads": hosts, "readBytes": len(reads)}


def sent_chats():
    """The chats with writes sent under a host permission that the daemon has not taken yet."""
    with state.locked():
        root = state.sent_path()
        chats = sorted(os.listdir(root)) if os.path.isdir(root) else []
        found = []
        for chat in chats:
            if chat.isdigit() and any(entry.endswith(".json") for entry in os.listdir(os.path.join(root, chat))):
                found.append(int(chat))
        return found


def ack(chat, read_bytes, ids):
    with state.locked():
        for one in ids:
            # a ticket names a held request, an id that starts with s a write sent under a host permission
            kind = "sent" if one.startswith("s") else "held"
            if os.path.basename(one) != one or one in ("", ".", ".."):
                continue
            try:
                folder = state.kept(kind, chat)
                os.remove(os.path.join(folder, f"{one}.json"))
            except FileNotFoundError:
                pass
        target = state.kept("reads", chat)
        try:
            with open(target, "rb") as handle:
                rest = handle.read()[read_bytes:]
        except FileNotFoundError:
            return
        if rest:
            with open(f"{target}.tmp", "wb") as handle:
                handle.write(rest)
            os.replace(f"{target}.tmp", target)
        else:
            os.remove(target)


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS to a pinned address, verified against the host's name."""

    def __init__(self, host, address, port, context):
        super().__init__(host, port, context=context, timeout=60)
        self._address = address

    def connect(self):
        sock = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, address, port):
        super().__init__(host, port, timeout=60)
        self._address = address

    def connect(self):
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


def replay(request, progress):
    """Send it; `progress["reached"]` is set from the moment any of it may have left, for a failure to say so."""
    cfg = state.config()
    host, port = policy.name(request["host"]), int(request["port"])
    address, why = policy.pin(
        host, port, lambda h, p: [i[4][0] for i in socket.getaddrinfo(h, p, type=socket.SOCK_STREAM)],
        cfg.get("daemonPort"),
    )
    if why is not None:
        return {"refused": why}
    if request["scheme"] == "https":
        connection = PinnedHTTPSConnection(host, address, port, ssl.create_default_context(cafile=certifi.where()))
    else:
        connection = PinnedHTTPConnection(host, address, port)
    credentials = policy.credential_for(host, cfg.get("credentials", []), request["scheme"])
    swapped = {header.lower() for header, _ in credentials}
    body = base64.b64decode(request["body"])
    # connected first: a server that cannot be reached has been sent nothing
    connection.connect()
    connection.putrequest(request["method"], request["path"], skip_host=True, skip_accept_encoding=True)
    # the server is named by the host it was held for, never by a Host header the box wrote
    default = 443 if request["scheme"] == "https" else 80
    named = f"[{host}]" if ":" in host else host
    connection.putheader("Host", named if port == default else f"{named}:{port}")
    framed = False
    for key, value in request["headers"]:
        if key.lower() in swapped or key.lower() in ("transfer-encoding", "host"):
            continue
        # the body is sent whole, so its framing is its length, where the box put it
        if key.lower() == "content-length":
            value = str(len(body))
            framed = True
        connection.putheader(key, value)
    for header, value in credentials:
        connection.putheader(header, value)
    if not framed and (body or request["method"].upper() not in ("GET", "HEAD", "OPTIONS")):
        connection.putheader("Content-Length", str(len(body)))
    progress["reached"] = True
    connection.endheaders(body)
    response = connection.getresponse()
    data = response.read(RESPONSE_LIMIT + 1)
    connection.close()
    every = cfg.get("credentials", [])
    return {
        "status": response.status,
        "reason": response.reason,
        "headers": [[k, policy.scrub(v.encode(), every).decode()] for k, v in response.getheaders()],
        "body": base64.b64encode(policy.scrub(data[:RESPONSE_LIMIT], every)).decode(),
        "truncated": len(data) > RESPONSE_LIMIT,
    }


def main(argv):
    command = argv[1]
    if command == "config":
        print(json.dumps(configure(json.load(sys.stdin))))
    elif command == "take":
        print(json.dumps(take(argv[2])))
    elif command == "sent":
        print(json.dumps(sent_chats()))
    elif command == "ack":
        ack(argv[2], int(argv[3]), argv[4:])
        print("{}")
    elif command == "pass":
        state.allow(int(argv[2]), argv[3])
        print("{}")
    elif command == "replay":
        progress = {}
        try:
            print(json.dumps(replay(json.load(sys.stdin), progress)))
        except (OSError, http.client.HTTPException, ssl.SSLError) as error:
            print(json.dumps({"failed": f"{type(error).__name__}: {error}", **progress}))
    elif command == "ping":
        try:
            socket.create_connection(("127.0.0.1", 8080), 2).close()
            listening = True
        except OSError:
            listening = False
        print(json.dumps({"up": listening and os.path.exists("/trust/ca-certificates.crt")}))
    else:
        sys.exit(f"unknown command {command}")


if __name__ == "__main__":
    main(sys.argv)
