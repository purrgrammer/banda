"""
The egress policy (DESIGN.md "The box", Network): pure decisions over addresses, hosts and requests, shared by the
proxy's addon (each request as it passes) and its control script (a held request, replayed). No I/O but the resolver
the caller hands in, so its rules are tested without a proxy.
"""

import hmac
import ipaddress
import re
import zlib
from hashlib import sha256
from urllib.parse import parse_qs, urlsplit

# Every range that is not the public internet: this host and this network, private and shared address space, loopback,
# link-local (cloud metadata lives there), documentation and benchmarking ranges, multicast and reserved space. An
# address embedding an IPv4 one (mapped, NAT64, 6to4) is judged by the IPv4 address it carries.
NOT_PUBLIC = [
    ipaddress.ip_network(net)
    for net in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "::/96",
        "100::/64",
        "2001::/23",
        "2001:db8::/32",
        "fc00::/7",
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
    )
]
NAT64 = [ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48")]
SIX_TO_FOUR = ipaddress.ip_network("2002::/16")

READS = {"GET", "HEAD", "OPTIONS"}
# A git fetch (`git_fetch`): its path and type, what its first line asks, and the most its request (the refs and
# objects it asks for) may weigh as sent and undone from gzip.
GIT_FETCH_PATH = re.compile(r"/(?:[A-Za-z0-9._~-]+/){1,8}git-upload-pack")
GIT_FETCH_TYPE = "application/x-git-upload-pack-request"
GIT_FETCH_COMMANDS = (b"command=ls-refs", b"command=fetch", b"command=object-info", b"command=bundle-uri")
GIT_FETCH_LIMIT = 1024 * 1024
GIT_FETCH_DECODED = 8 * 1024 * 1024


def _v4_part(text):
    """One part of a numeric IPv4 host as inet_aton reads it: hex (0x), octal (leading 0) or decimal; None if not."""
    if re.fullmatch(r"0[xX][0-9a-fA-F]*", text):
        return int(text[2:] or "0", 16)
    if re.fullmatch(r"0[0-7]*", text):
        return int(text, 8)
    if re.fullmatch(r"[1-9][0-9]*", text):
        return int(text)
    return None


def literal(host):
    """
    The address `host` spells, if it is one, in any form a resolver would take: dotted, decimal, octal or hex IPv4 with
    one to four parts, or IPv6 (bracketed or not). `False` when it looks numeric but is no valid address; None for a name.
    """
    host = host.strip().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if ":" in host:
        if "%" in host:
            return False
        try:
            return ipaddress.IPv6Address(host)
        except ValueError:
            return False
    parts = host.split(".")
    # a name whose last label is all digits (or hex) is read as an address by inet_aton, never looked up
    if not re.fullmatch(r"(0[xX][0-9a-fA-F]*|[0-9]+)", parts[-1]):
        return None
    if len(parts) > 4:
        return False
    values = [_v4_part(part) for part in parts]
    if any(value is None for value in values):
        return False
    *head, last = values
    if any(value > 255 for value in head) or last >= 256 ** (4 - len(head)):
        return False
    number = 0
    for value in head:
        number = number * 256 + value
    number = number * 256 ** (4 - len(head)) + last
    return ipaddress.IPv4Address(number)


def public(address):
    """Why `address` is not on the public internet, or None when it is."""
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return public(address.ipv4_mapped)
        if any(address in net for net in NAT64):
            return public(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF))
        if address in SIX_TO_FOUR:
            return public(address.sixtofour)
    for net in NOT_PUBLIC:
        if address in net:
            return f"{address} is not a public address"
    if address.is_loopback or address.is_link_local or address.is_private or address.is_multicast:
        return f"{address} is not a public address"
    return None


def pin(host, port, resolve, daemon_port=None):
    """
    The one address a request to `host`:`port` goes to, resolved once: `(address, None)`, or `(None, why)` when the
    host is refused. Every address it resolves to must be public, so a name cannot mix a public and a private answer.
    `resolve(host, port)` returns the addresses a name resolves to, as text.
    """
    if daemon_port is not None and port == daemon_port:
        return None, f"port {port} is banda's own"
    spelled = literal(host)
    if spelled is False:
        return None, f"{host} is not a valid address"
    if spelled is not None:
        addresses = [spelled]
    else:
        try:
            addresses = [ipaddress.ip_address(a.split("%")[0]) for a in resolve(host, port)]
        except (OSError, ValueError) as error:
            return None, f"{host} does not resolve: {error}"
        if not addresses:
            return None, f"{host} does not resolve"
    for address in addresses:
        why = public(address)
        if why is not None:
            return None, f"{host} is not on the public internet ({why})"
    first = addresses[0]
    # a mapped address is its IPv4 address, which is where it goes
    if isinstance(first, ipaddress.IPv6Address) and first.ipv4_mapped is not None:
        first = first.ipv4_mapped
    return str(first), None


def name(host):
    """A host as policy compares it: lower case, no trailing dot, no brackets."""
    host = host.strip().lower().rstrip(".")
    return host[1:-1] if host.startswith("[") and host.endswith("]") else host


def listed(host, hosts):
    """Whether `host` is on the list: named exactly, or under an entry `*.example.com`."""
    host = name(host)
    for entry in hosts:
        entry = name(entry)
        if entry.startswith("*.") and host.endswith(entry[1:]):
            return True
        if host == entry:
            return True
    return False


def _pkt_lines(body):
    """`body`'s pkt-lines (git's framing: four hex digits of length, then the data), or None if it is not framed so."""
    lines, at = [], 0
    while at < len(body):
        size = body[at : at + 4]
        if len(size) < 4 or not re.fullmatch(rb"[0-9a-f]{4}", size):
            return None
        n = int(size, 16)
        if n in (0, 1, 2):
            # flush, delimiter, response end: no data
            at += 4
            continue
        if n < 4 or at + n > len(body):
            return None
        lines.append(body[at + 4 : at + n])
        at += n
    return lines


def _decoded(raw, encoding):
    """A git request's body as sent, undone from its encoding (none, or gzip as git sends it), never past the limit."""
    encoding = encoding.strip().lower()
    if encoding in ("", "identity"):
        return raw
    if encoding != "gzip":
        return None
    inflate = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        body = inflate.decompress(raw, GIT_FETCH_DECODED + 1)
    except zlib.error:
        return None
    if len(body) > GIT_FETCH_DECODED or not inflate.eof:
        return None
    return body


def git_fetch(host, method, headers, url, raw, hosts):
    """
    Whether a request is a git fetch over smart HTTP, which reads: upload-pack only ever sends refs and objects back.
    A body that looks like git does not prove the server is git, so it holds only for the forges the daemon names
    (`hosts`); there, a POST to `/<path>/git-upload-pack` (plain segments, no query) of git's own type, its body
    (no larger than the limits, undone from gzip) framed as pkt-lines whose first asks for refs or objects:
    `command=ls-refs`, `fetch`, `object-info` or `bundle-uri` in protocol v2, `want <id>` in v0. Checked in that
    order, so nothing is decoded for any other request. Anything else stays a write.
    """
    if method.upper() != "POST" or not listed(host, hosts):
        return False
    parts = urlsplit(url)
    if parts.query or parts.fragment or not GIT_FETCH_PATH.fullmatch(parts.path):
        return False
    if any(segment in (".", "..") for segment in parts.path.split("/")):
        return False
    kind = ",".join(value for key, value in headers if key.lower() == "content-type")
    if kind.split(";")[0].strip().lower() != GIT_FETCH_TYPE:
        return False
    if raw is None or len(raw) > GIT_FETCH_LIMIT:
        return False
    encoding = ",".join(value for key, value in headers if key.lower() == "content-encoding")
    body = _decoded(raw, encoding)
    lines = None if body is None else _pkt_lines(body)
    if not lines:
        return False
    first = lines[0]
    # git ends a line with a newline or not (2.39 sends `command=fetch` bare)
    return first.rstrip(b"\n") in GIT_FETCH_COMMANDS or first.startswith(b"want ")


def is_write(method, headers, url=""):
    """
    Whether a request writes: any method but GET, HEAD and OPTIONS; a WebSocket upgrade; and a GraphQL mutation sent
    as a GET (its query in the URL), which writes whatever its verb says. A git fetch to a named forge (`git_fetch`)
    is a write by these rules that the proxy reads.
    """
    if method.upper() not in READS:
        return True
    upgrade = ",".join(value for key, value in headers if key.lower() == "upgrade")
    if "websocket" in upgrade.lower():
        return True
    parts = urlsplit(url)
    for query in parse_qs(parts.query).get("query", []):
        if re.match(r"\s*mutation\b", query):
            return True
    return False


DEFAULT_PORTS = {"http": 80, "https": 443}
# Headers that carry a credential, as the daemon's floor names them (egress.ts SECRET_HEADERS), and query parameters
# that do (SECRET_QUERY): a request the box sends with one is on the floor, never covered by a permission. A credential
# inside a body is not looked for: what a body carries is its own format's.
SECRET_HEADERS = {
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "private-token",
    "x-auth-token",
    "x-access-token",
}
SECRET_QUERY = {"access_token", "token", "api_key", "apikey", "private_token"}


def permitted_host(scheme, host, port):
    """
    The host a host permission binds, as the daemon spells it (egress.ts `permittedHost`): its name in lower case, its
    port unless the scheme's, and its scheme unless https.
    """
    host = name(host)
    spelled = f"[{host}]" if ":" in host else host
    if port != DEFAULT_PORTS.get(scheme):
        spelled = f"{spelled}:{port}"
    return spelled if scheme == "https" else f"{scheme}://{spelled}"


def own_credentials(headers, path=""):
    """Whether a request carries a credential of its own, in a header or its query: then it is on the floor."""
    if any(key.strip().lower() in SECRET_HEADERS for key, _ in headers):
        return True
    query = urlsplit(path).query
    return any(key.strip().lower() in SECRET_QUERY for key in parse_qs(query, keep_blank_values=True))


def host_covers(allowed, spelled):
    """
    Whether the allowed host `allowed` covers `spelled`, both as `permitted_host` spells them: the same, or a pattern
    whose name is `*` (every host) or `*.example.com` (any name under example.com, never example.com itself), with the
    same scheme and port.
    """
    if allowed == spelled:
        return True

    def split(value):
        scheme, sep, rest = value.partition("://")
        if not sep:
            scheme, rest = "https", value
        if rest.startswith("["):
            close = rest.find("]")
            return scheme, rest[: close + 1], rest[close + 1 :]
        named, colon, port = rest.partition(":")
        return scheme, named, colon + port

    scheme, named, port = split(allowed)
    if not named.startswith("*"):
        return False
    other_scheme, other_name, other_port = split(spelled)
    if (scheme, port) != (other_scheme, other_port) or other_name.startswith("["):
        return False
    return named == "*" or (named.startswith("*.") and other_name.endswith(named[1:]))


def direct_write(scheme, host, port, headers, path, permitted):
    """
    Whether a write goes straight through, as it happens: its host is one the owner allowed for its chat's agent
    (`permitted`, which the daemon's config names for that chat, exactly or by a pattern `host_covers` reads), and it
    carries no credential of its own (the floor). A WebSocket upgrade there opens a stream, recorded as it opens.
    Anything else is held.
    """
    spelled = permitted_host(scheme, host, port)
    if not any(host_covers(allowed, spelled) for allowed in permitted):
        return False
    return not own_credentials(headers, path)


def is_websocket(headers):
    """Whether a request asks to become a WebSocket."""
    upgrade = ",".join(value for key, value in headers if key.lower() == "upgrade")
    return "websocket" in upgrade.lower()


def held_words(ticket, scheme, host, port, headers, path=""):
    """What the box hears of a write held as `ticket`: that it waits, and how the next one goes straight through."""
    said = f"this request writes, so it waits for the owner: ticket {ticket}. It has not been sent."
    if is_websocket(headers) and own_credentials(headers, path):
        return (
            f"{said} A WebSocket is a stream, never sent as one request, and one carrying a credential of its own is "
            "never let through: it will not be sent. Open it without that credential."
        )
    if own_credentials(headers, path):
        return f"{said} It carries a credential of its own, so the owner is asked every time."
    allowed = permitted_host(scheme, host, port)
    if is_websocket(headers):
        return (
            f"{said} A WebSocket is a stream, never sent as one request: ask the owner to allow {allowed} with "
            "ask_hosts (with every other host the task needs), then run the command again."
        )
    return (
        f"{said} When this command ends you are told what happens to it. Before writing more there, ask the "
        f"owner to allow {allowed} with ask_hosts (it takes several hosts at once): once allowed, writes there go "
        "straight through."
    )


def same_server(target, host_header, sni=None, hosts=()):
    """
    Why a request to `target` names another server, or None: its authority (`host_header`), any Host header it also
    carries (`hosts`: HTTP/2 names its server by its authority, so a Host header beside it would reach another server
    sharing the address, a CDN's front), or its TLS name.
    """
    target = name(target)
    for spelled in [host_header, *hosts]:
        if spelled is None:
            continue
        spelled = spelled.strip()
        spelled = spelled.rsplit(":", 1)[0] if not spelled.endswith("]") and spelled.count(":") == 1 else spelled
        if name(spelled) != target:
            return f"its Host names {name(spelled)}, not {target}"
    if sni is not None and name(sni) != target:
        return f"its TLS name is {name(sni)}, not {target}"
    return None


def identity(username, password, key):
    """The chat a proxy login names, if its password is the daemon's mark for it; else None."""
    # c0 is nobody's chat (the daemon's own listing), which only reads
    if not re.fullmatch(r"c(0|[1-9][0-9]{0,15})", username or ""):
        return None
    if not hmac.compare_digest(mark(key, username), password or ""):
        return None
    return int(username[1:])


def browser_login(username, password, key):
    """The agent whose browser a proxy login is (`b-<agent>`, marked by the daemon), or None."""
    found = re.fullmatch(r"b-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)", username or "")
    if found is None or len(username) > 66:
        return None
    if not hmac.compare_digest(mark(key, username), password or ""):
        return None
    return found.group(1)


def tab_chat(stamp, key, agent):
    """The chat a tab of `agent`'s browser stamped (`<chat>.<mark>`), if the mark is the daemon's for that agent and chat."""
    found = re.fullmatch(r"([1-9][0-9]{0,15})\.([0-9a-f]{32})", stamp or "")
    if found is None or key is None:
        return None
    if not hmac.compare_digest(mark(key, f"t{agent}:{found.group(1)}"), found.group(2)):
        return None
    return int(found.group(1))


def write_hash(method, host, port, path, body):
    """What a write the owner approved in the browser is let through by: its method, server, path and body's bytes."""
    head = f"{method.upper()}\n{name(host)}:{port}\n{path}\n".encode()
    return sha256(head + (body or b"")).hexdigest()


def mark(key, username):
    """The daemon's mark for a proxy login: its key's MAC of the username."""
    return hmac.new(bytes.fromhex(key), f"banda-egress:{username}".encode(), sha256).hexdigest()[:32]


def credential_for(host, credentials, scheme="https"):
    """
    The credentials the daemon gave for `host` (header and value pairs), set only over the scheme each names (https
    unless it says `http`): a request the box sends over plain http never carries the owner's key in the clear.
    """
    return [
        (c["header"], c["value"])
        for c in credentials
        if name(c["host"]) == name(host) and c.get("scheme", "https") == scheme
    ]


def _secrets(credentials):
    """What `scrub` removes for each credential: the whole value, and its secret alone ("Bearer <secret>")."""
    for c in credentials:
        value = c["value"]
        for secret in sorted({value, value.split()[-1] if value.split() else ""}, key=len, reverse=True):
            if len(secret) >= 8:
                yield secret.encode()


def scrub(data, credentials):
    """`data` (bytes) with every credential value the daemon gave replaced, so a response cannot echo one."""
    for secret in _secrets(credentials):
        data = data.replace(secret, b"[removed by banda]")
    return data


def decoder(encoding):
    """
    A response body's `Content-Encoding` undone as it arrives: a function of each chunk that returns its bytes as sent,
    and of `b""` (the end) what is left; None for an encoding it cannot undo (several, or one it does not know).
    """
    encoding = encoding.strip().lower()
    if encoding in ("", "identity"):
        return lambda chunk: chunk
    if encoding in ("gzip", "x-gzip", "deflate"):
        inflate = zlib.decompressobj(16 + zlib.MAX_WBITS if encoding != "deflate" else zlib.MAX_WBITS)
        return lambda chunk: inflate.decompress(chunk) if chunk else inflate.flush()
    if encoding == "br":
        import brotli  # in the proxy's image, as mitmproxy's own

        inflate = brotli.Decompressor()
        return lambda chunk: inflate.process(chunk) if chunk else b""
    if encoding == "zstd":
        import zstandard  # in the proxy's image, as mitmproxy's own

        inflate = zstandard.ZstdDecompressor().decompressobj()
        return lambda chunk: inflate.decompress(chunk) if chunk else b""
    return None


def scrubber(credentials):
    """
    `scrub` over a body that arrives in chunks: a function of each chunk that returns what may go on, and of `b""`
    (the end) what is left. It holds back the last bytes of what it saw, one fewer than the longest secret, so a
    secret split across chunks is whole in what it scrubs next; any secret that starts before them ends inside it.
    """
    keep = max((len(secret) for secret in _secrets(credentials)), default=1) - 1
    held = b""

    def stream(chunk):
        nonlocal held
        data = scrub(held + chunk, credentials)
        if chunk == b"" or keep == 0:
            held = b""
            return data
        held = data[-keep:]
        return data[:-keep]

    return stream
