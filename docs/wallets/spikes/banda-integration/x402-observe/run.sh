#!/bin/sh
# x402 observation spike: an HTTPS resource server answering 402 (v2 PAYMENT-REQUIRED), banda's pinned mitmproxy image
# with a minimal observing addon, and a client trusting only the proxy's CA. Two runs: upstream CA trusted by the proxy
# (as a public CA would be), and not trusted (a forged or self-signed server). Cleans up everything it makes.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
net="banda-spike-x402-$suffix"
mitm="mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f"
py="python:3.13-slim"
cleanup() {
  docker rm -f "up-$suffix" "proxy-$suffix" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# an invented CA and a server certificate for pay.test
mkdir -p "$work/certs" "$work/mitm" "$work/out"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=spike-ca" -keyout "$work/certs/ca.key" -out "$work/certs/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=pay.test" -keyout "$work/certs/server.key" -out "$work/certs/server.csr" 2>/dev/null
printf "subjectAltName=DNS:pay.test\n" > "$work/certs/ext.cnf"
openssl x509 -req -in "$work/certs/server.csr" -CA "$work/certs/ca.pem" -CAkey "$work/certs/ca.key" -CAcreateserial -days 1 -extfile "$work/certs/ext.cnf" -out "$work/certs/server.pem" 2>/dev/null
chmod -R a+rwX "$work"

docker network create "$net" >/dev/null
docker run -d --name "up-$suffix" --network "$net" --network-alias pay.test -v "$work/certs:/certs:ro" -v "$here/upstream.py:/upstream.py:ro" "$py" python3 /upstream.py >/dev/null

run() {  # $1: label, $2..: extra mitmdump options
  label=$1; shift
  rm -f "$work/out/observations.jsonl"
  docker rm -f "proxy-$suffix" >/dev/null 2>&1 || true
  docker run -d --name "proxy-$suffix" --network "$net" --network-alias proxy \
    -v "$work/mitm:/conf" -v "$work/out:/out" -v "$work/certs:/certs:ro" -v "$here/observe.py:/observe.py:ro" \
    --entrypoint mitmdump "$mitm" --quiet --listen-port 8080 --set block_global=false --set confdir=/conf -s /observe.py "$@" >/dev/null
  i=0; until [ -f "$work/mitm/mitmproxy-ca-cert.pem" ] || [ $i -ge 50 ]; do sleep 0.2; i=$((i+1)); done
  sleep 1
  echo "== $label"
  docker logs "proxy-$suffix" 2>&1 | tail -3
  docker run --rm --network "$net" -v "$work/mitm:/mitm:ro" -v "$here/client.py:/client.py:ro" "$py" python3 /client.py "https://pay.test:8443/v1/forecast?city=lisbon&units=c" || true
  echo "-- observations:"
  cat "$work/out/observations.jsonl" 2>/dev/null || echo "(none)"
}
run "upstream CA trusted by the proxy" --set ssl_verify_upstream_trusted_ca=/certs/ca.pem
run "upstream CA not trusted (mitmproxy defaults: certifi)"
