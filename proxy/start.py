"""
The egress proxy's entry: the banda certificate authority made once (kept on its volume, so the box keeps trusting it
when the proxy is made again), handed to the box as the only one it trusts, then mitmproxy with the policy addon.
"""

import os
import shutil
from pathlib import Path

from mitmproxy.certs import CertStore

CA = Path("/ca")
TRUST = Path("/trust")

if not (CA / "mitmproxy-ca.pem").exists():
    CertStore.create_store(CA, "mitmproxy", 2048, organization="banda", cn="banda")
# the box's whole trust store: this one authority
temporary = TRUST / "ca-certificates.crt.tmp"
shutil.copyfile(CA / "mitmproxy-ca-cert.pem", temporary)
os.chmod(temporary, 0o644)
os.replace(temporary, TRUST / "ca-certificates.crt")
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
