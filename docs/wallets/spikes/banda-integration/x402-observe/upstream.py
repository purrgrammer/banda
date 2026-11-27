"""A resource server that answers every GET with x402 v2's 402: PAYMENT-REQUIRED is base64 JSON (invented values)."""
import base64, json, ssl
from http.server import BaseHTTPRequestHandler, HTTPServer

REQUIRED = {
    "x402Version": 2,
    "resource": {"url": "https://pay.test:8443/v1/forecast"},
    "accepts": [{
        "scheme": "exact", "network": "eip155:84532", "amount": "10000",
        "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "payTo": "0x1111111111111111111111111111111111111111",
        "maxTimeoutSeconds": 60, "extra": {"name": "USDC", "version": "2"},
    }],
}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"error":"payment required"}'
        self.send_response(402)
        self.send_header("PAYMENT-REQUIRED", base64.b64encode(json.dumps(REQUIRED).encode()).decode())
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

server = HTTPServer(("0.0.0.0", 8443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/certs/server.pem", "/certs/server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
