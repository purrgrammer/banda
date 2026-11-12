#!/bin/sh
set -eu

# Startup and health checks never search software installed by an agent.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

privileged_ports() {
	floor=$(/bin/cat /proc/sys/net/ipv4/ip_unprivileged_port_start)
	[ "$floor" -ge 1024 ]
}

ipv6_loopback_only() {
	for conf in /proc/sys/net/ipv6/conf/*; do
		case "${conf##*/}" in all | lo) continue ;; esac
		[ "$(/bin/cat "$conf/disable_ipv6")" = 1 ] || return 1
	done
}

if [ "$#" -eq 1 ] && [ "$1" = --check ]; then
	privileged_ports
	ipv6_loopback_only
	exec /usr/bin/socat -T 2 -u OPEN:/dev/null,rdonly TCP4:127.0.0.1:80,connect-timeout=2
fi
if [ "$#" -ne 0 ]; then
	printf '%s\n' 'The proxy bridge takes no destination argument.' >&2
	exit 1
fi
if ! privileged_ports; then
	printf '%s\n' 1024 > /proc/sys/net/ipv4/ip_unprivileged_port_start
fi
privileged_ports

# These no-net guests reach the proxy through IPv4 loopback and vsock. Finish address changes before Chromium starts:
# the kernel's delayed IPv6 duplicate-address check would otherwise interrupt its first requests.
for conf in /proc/sys/net/ipv6/conf/*; do
	case "${conf##*/}" in all | lo) continue ;; esac
	printf '%s\n' 1 > "$conf/disable_ipv6"
done
ipv6_loopback_only

# The root parent accepts; each relay child drops UID, GID and inherited groups.
exec /usr/bin/socat -t 30 \
	TCP4-LISTEN:80,bind=127.0.0.1,reuseaddr,fork,backlog=128,max-children=128,su=banda-bridge \
	VSOCK-CONNECT:2:23456
