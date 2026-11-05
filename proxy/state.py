"""
The proxy's state, in files. Under /state (a tmpfs: gone with the container, which the daemon refills): the daemon's
config and the browser's one-time passes. Under /kept (a volume, which outlives a restart, a kill and the container
made again): what only the proxy knows until the daemon takes it, the requests held as tickets, the hosts each chat
read, and the writes sent under a host permission; a proxy stopped for any reason so never forgets them. The addon and the control script are separate processes, so every change happens under
one lock and lands by rename.
"""

import fcntl
import json
import os
import secrets
import time
from contextlib import contextmanager

ROOT = os.environ.get("BANDA_STATE", "/state")
KEPT_ROOT = os.environ.get("BANDA_KEPT", "/kept")
EMPTY = {
    "key": None,
    "git": [],
    "daemonPort": None,
    "credentials": [],
    "permitted": {},
    "browsers": {},
}


def path(*parts):
    return os.path.join(ROOT, *parts)


@contextmanager
def locked():
    os.makedirs(ROOT, exist_ok=True)
    with open(path("lock"), "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def write_json(target, value):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temporary = f"{target}.{os.getpid()}.tmp"
    with open(temporary, "w") as handle:
        json.dump(value, handle)
    os.replace(temporary, target)


def read_json(target, default):
    try:
        with open(target) as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


_config = (None, EMPTY)


def kept(*parts):
    """Where what only the proxy knows until the daemon takes it lives: the volume."""
    return os.path.join(KEPT_ROOT, *parts)


def config():
    """
    The daemon's config, read again when it changed: keyed on the file's inode and its time, as every write lands by
    rename (a new inode), so two writes within one tick of the clock are never taken for one.
    """
    global _config
    try:
        found = os.stat(path("config.json"))
    except FileNotFoundError:
        return EMPTY
    stamp = (found.st_ino, found.st_mtime_ns, found.st_size)
    if _config[0] != stamp:
        _config = (stamp, read_json(path("config.json"), EMPTY))
    return _config[1]


def read(chat, host):
    """Note that `chat` read from `host`."""
    with locked():
        os.makedirs(kept("reads"), exist_ok=True)
        with open(kept("reads", str(chat)), "a") as handle:
            handle.write(host + "\n")


def hold(chat, request):
    """Hold `request` for `chat` as a ticket; its id."""
    ticket = "t" + secrets.token_hex(5)
    with locked():
        write_json(
            kept("held", str(chat), f"{ticket}.json"),
            {**request, "ticket": ticket, "at": int(time.time() * 1000)},
        )
    return ticket


def sent_path(*parts):
    """Where the writes sent under a host permission are noted, on the volume."""
    return kept("sent", *parts)


def sent(chat, record):
    """
    Note, before it is sent, that a write of `chat` goes straight through under a host permission; its id, for its
    outcome and the daemon's ack.
    """
    sent_id = "s" + secrets.token_hex(5)
    with locked():
        write_json(
            sent_path(str(chat), f"{sent_id}.json"),
            {**record, "id": sent_id, "chat": chat, "at": int(time.time() * 1000)},
        )
    return sent_id


def outcome(chat, sent_id, what):
    """
    Note how a write sent under a host permission ended: `{"status": n}` once its server answered, else
    `{"failed": why, "reached": bool}`. The first outcome stands.
    """
    with locked():
        target = sent_path(str(chat), f"{sent_id}.json")
        record = read_json(target, None)
        if record is None or "status" in record or "failed" in record:
            return
        write_json(target, {**record, **what})


# How long a pass waits for its write, in milliseconds: the browser sends it as soon as it is let go, so one unused this
# long was never sent, and is never used later.
PASS_MS = 60_000


def allow(chat, digest):
    """Let one write of `chat` whose hash is `digest` pass, once, within `PASS_MS`: the daemon let it go."""
    # each chat's passes its own: two chats approving the same bytes never use up each other's
    with locked():
        write_json(path("passes", str(int(chat)), digest), {"chat": chat, "at": int(time.time() * 1000)})


def passes(chat, digest):
    """Whether a write of `chat` hashed `digest` was let through, not longer than `PASS_MS` ago; the pass is used up."""
    with locked():
        target = path("passes", str(int(chat)), digest)
        found = read_json(target, None)
        if found is None:
            return False
        os.remove(target)
        fresh = int(time.time() * 1000) - int(found.get("at", 0)) <= PASS_MS
        return found.get("chat") == chat and fresh
