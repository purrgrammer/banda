#!/bin/sh
# Gap H on Linux (headless, in Docker, gnome-keyring): findCredentials with the login collection unlocked, then locked.
set -u
cd /opt/spike
case "${1:-}" in
"") exec dbus-run-session -- sh "$0" in ;;
in)
	printf 'spike-pw' | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
	echo "--- unlocked collection"
	node --no-warnings find.mjs
	echo "--- the attributes an Entry writes (secret-tool, attributes only)"
	S="banda-spike-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	node -e 'const {Entry}=require("@napi-rs/keyring"); new Entry(process.argv[1],"home-test/wallet/0xa1",{linux:{store:"secret-service"}}).setPassword("x".repeat(66))' "$S"
	secret-tool search --all service "$S" 2>&1 | grep -v '^secret = ' | sed "s/$S/<service>/"
	echo "--- findCredentials with the login collection locked (killed at 20 s)"
	timeout -s KILL 10 dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets \
		org.freedesktop.Secret.Service.Lock array:objpath:/org/freedesktop/secrets/collection/login >/dev/null; echo "lock exit $?"
	timeout -s KILL 20 node -e 'const {findCredentials}=require("@napi-rs/keyring"); const t=performance.now(); try { const r=findCredentials(process.argv[1]); console.log("returned", r.length, "credential(s) in", (performance.now()-t).toFixed(1), "ms") } catch (e) { console.log("threw in", (performance.now()-t).toFixed(1), "ms:", e.message) }' "$S"; echo "exit $?"
	printf 'spike-pw' | gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null 2>&1; sleep 1
	node -e 'const {Entry,findCredentials}=require("@napi-rs/keyring"); new Entry(process.argv[1],"home-test/wallet/0xa1",{linux:{store:"secret-service"}}).deletePassword(); console.log("after unlock and delete:", findCredentials(process.argv[1]).length, "left")' "$S"
	;;
esac
