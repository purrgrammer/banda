"""
The egress proxy's entry: the banda certificate authority made once (kept on its volume, so the box keeps trusting it
when the proxy is made again), handed to the box as the only one it trusts, then mitmproxy with the policy addon.
"""

import os
from pathlib import Path

CA = Path("/ca")
TRUST = Path("/trust")

def publish_trust(authority, target):
    certificate = authority.read_bytes()
    try:
        if target.read_bytes() == certificate:
            return
    except FileNotFoundError:
        pass
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_bytes(certificate)
    os.chmod(temporary, 0o644)
    os.replace(temporary, target)


def main():
    from mitmproxy.certs import CertStore

    if not (CA / "mitmproxy-ca.pem").exists():
        CertStore.create_store(CA, "mitmproxy", 2048, organization="banda", cn="banda")
    publish_trust(CA / "mitmproxy-ca-cert.pem", TRUST / "ca-certificates.crt")
    os.makedirs("/state", exist_ok=True)
    os.execvp(
        "mitmdump",
        [
            "mitmdump",
            "--quiet",
            "--listen-port",
            "8080",
            "--set",
            f"confdir={CA}",
            "--set",
            "block_global=false",
            "--scripts",
            "/banda/addon.py",
        ],
    )


if __name__ == "__main__":
    main()
