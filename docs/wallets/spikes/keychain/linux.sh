#!/bin/sh
# Micro-spike (Linux, headless, in Docker): @napi-rs/keyring against the Secret Service in each state.
#   linux.sh unlocked | locked | prompt | nodbus | nosecrets | notstarted
# Scenarios that need a session bus re-enter this script under dbus-run-session as "in-<scenario>".
set -u
cd /opt/spike
rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
S="banda-spike-$(rnd 6)"
A="home-$(rnd 4)/wallet/0"
k() { node kc.mjs "$@" "$S" "$A"; }
ks() { KC_STORE=secret-service node kc.mjs "$@" "$S" "$A"; }
kk() { KC_STORE=keyutils node kc.mjs "$@" "$S" "$A"; }
say() { echo "--- $*"; }
unlock() { printf 'spike-pw' | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>/tmp/gk.err; sed -n 1,3p /tmp/gk.err; }

case "$1" in
unlocked | locked | notstarted | prompt)
	exec dbus-run-session -- sh "$0" "in-$1" ;;
nosecrets)
	rm -f /usr/share/dbus-1/services/org.freedesktop.secrets.service /usr/share/dbus-1/services/org.gnome.keyring.service
	exec dbus-run-session -- sh "$0" in-nosecrets ;;
in-unlocked)
	unlock
	say "bench, default store (auto)"; node kc.mjs bench "$S" "$A" 20
	say "bench, store pinned to secret-service"; KC_STORE=secret-service node kc.mjs bench "$S" "$A" 20
	say "which store does the default (auto) pick while the Secret Service is up?"
	k set; echo "items in the Secret Service for it: $(secret-tool search --all service "$S" 2>/dev/null | grep -c '^label')"
	kk get; ks get; k del
	say "set in one process, get in another, get from a copy of node at another path"
	ks set; ks get
	cp "$(command -v node)" /tmp/node-copy && KC_STORE=secret-service /tmp/node-copy kc.mjs get "$S" "$A" 5000
	say "the item as the Secret Service shows it (attributes only)"
	secret-tool search --all service "$S" 2>&1 | grep -v '^secret = '
	say "8 concurrent first sets"; ks del >/dev/null
	for i in 1 2 3 4 5 6 7 8; do ks race & done; wait
	echo "items in the Secret Service after the race: $(secret-tool search --all service "$S" 2>/dev/null | grep -c '^label')"
	ks get; ks del; ks del; ks del
	echo "items left: $(secret-tool search --all service "$S" 2>/dev/null | grep -c '^label')"
	say "secret-tool store reads the secret from stdin (never argv)"
	K=$(rnd 32)
	printf '%s' "$K" | secret-tool store --label=spike service "$S-st" account "$A"
	[ "$(secret-tool lookup service "$S-st" account "$A")" = "$K" ] && echo "secret-tool round trip: match"
	secret-tool clear service "$S-st" account "$A"; echo "secret-tool cleared: $?"
	;;
in-locked)
	unlock
	ks set
	say "lock the login collection"
	timeout -s KILL 10 dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets \
		org.freedesktop.Secret.Service.Lock array:objpath:/org/freedesktop/secrets/collection/login | tail -n +2 | tr -s ' \n' ' '
	echo; echo "lock exit $?"
	echo "Locked = $(timeout 5 dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets/collection/login \
		org.freedesktop.DBus.Properties.Get string:org.freedesktop.Secret.Collection string:Locked | tail -1 | tr -s ' ')"
	say "get on a locked collection (AsyncEntry, AbortSignal 8 s, killed at 20 s)"
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs get "$S" "$A" 8000; echo "exit $?"
	say "sync set / del on a locked collection (killed at 20 s)"
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs set "$S" "$A"; echo "exit $?"
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs del "$S" "$A"; echo "exit $?"
	say "default store (auto) on a locked collection"
	timeout -s KILL 20 node kc.mjs get "$S" "$A" 8000; echo "exit $?"
	say "unlock again (gnome-keyring-daemon --unlock --replace), then clean up"
	printf 'spike-pw' | timeout 10 gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null 2>&1
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs get "$S" "$A" 8000
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs del "$S" "$A"
	;;
in-prompt)
	say "a display (Xvfb) so the unlock prompt opens and nobody answers it"
	Xvfb :99 -nolisten tcp >/dev/null 2>&1 & export DISPLAY=:99; sleep 1
	dbus-update-activation-environment DISPLAY # services the bus starts (gcr-prompter) see the display
	unlock; ks set
	timeout -s KILL 10 dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets \
		org.freedesktop.Secret.Service.Lock array:objpath:/org/freedesktop/secrets/collection/login >/dev/null; echo "locked: $?"
	say "1 get behind the prompt; hang.mjs calls process.exit(0) at 8 s (SIGKILL at 20 s)"
	t=$(date +%s); timeout -s KILL 20 node hang.mjs "$S" "$A" 1 >/tmp/h.out 2>&1; st=$?
	grep '^{' /tmp/h.out; echo "node exit status $st after $(( $(date +%s) - t )) s"
	ps -eo pid,args | grep gcr-prompter | grep -v grep
	say "4 gets behind the prompt (default threadpool of 4); same exit"
	t=$(date +%s); timeout -s KILL 20 node hang.mjs "$S" "$A" 4 >/tmp/h.out 2>&1; st=$?
	grep '^{' /tmp/h.out; echo "node exit status $st after $(( $(date +%s) - t )) s"
	say "1 get behind the prompt, SIGTERM at 3 s with no handler (default action)"
	t=$(date +%s); timeout -s TERM 3 node hang.mjs "$S" "$A" 1 >/dev/null 2>&1
	echo "timeout status $? after $(( $(date +%s) - t )) s"
	say "unlock again, then clean up"
	printf 'spike-pw' | timeout 10 gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null 2>&1
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs del "$S" "$A"
	;;
in-notstarted)
	say "session bus up, gnome-keyring installed but not running, no login keyring yet"
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs set "$S" "$A"; echo "exit $?"
	ps -eo pid,args | grep -E 'gnome-keyring|gcr-prompter' | grep -v grep
	timeout -s KILL 20 env KC_STORE=secret-service node kc.mjs get "$S" "$A" 8000; echo "exit $?"
	say "default store (auto)"
	timeout -s KILL 20 node kc.mjs set "$S" "$A"; echo "exit $?"
	timeout -s KILL 20 node kc.mjs get "$S" "$A" 8000; echo "exit $?"
	timeout -s KILL 20 node kc.mjs del "$S" "$A"; echo "exit $?"
	;;
in-nosecrets)
	say "session bus up, no Secret Service provider"
	ks set; ks get
	say "default store (auto)"
	k set; k get; say "a second process with the store pinned to keyutils"; kk get; k del
	;;
nodbus)
	unset DBUS_SESSION_BUS_ADDRESS
	say "no session bus; store pinned to secret-service"
	ks set
	say "default store (auto)"
	k set; k get
	say "a second process with the store pinned to keyutils"; kk get
	k del
	;;
*) echo "usage: linux.sh unlocked|locked|prompt|nodbus|nosecrets|notstarted"; exit 2 ;;
esac
