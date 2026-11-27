"""The box's side: a GET through the proxy, trusting only the proxy's CA, as banda's box does."""
import json, ssl, sys, urllib.request, urllib.error
url = sys.argv[1]
context = ssl.create_default_context(cafile="/mitm/mitmproxy-ca-cert.pem")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": "http://proxy:8080"}), urllib.request.HTTPSHandler(context=context))
try:
    response = opener.open(url, timeout=20)
    print(json.dumps({"status": response.status}))
except urllib.error.HTTPError as error:
    print(json.dumps({"status": error.code, "x-banda-challenge": error.headers.get("x-banda-challenge"), "payment-required": (error.headers.get("payment-required") or "")[:40] + "…", "body": error.read()[:160].decode(errors="replace")}))
