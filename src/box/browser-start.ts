export const BROWSER_UID = 65533;

const PREFERENCES = JSON.stringify({
	credentials_enable_service: false,
	credentials_enable_autosignin: false,
	profile: { password_manager_enabled: false },
	autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
	session: { restore_on_startup: 5 },
	signin: { allowed: false },
	browser: { enable_spellchecking: false },
	search: { suggest_enabled: false },
});

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Chromium's private UID imports the proxy CA and exposes CDP only on its inherited pipe. */
export function browserStart({
	agent,
	proxy,
	trust,
}: {
	readonly agent: string;
	readonly proxy: string;
	readonly trust: string;
}): string {
	if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agent)) throw new Error("Invalid browser agent id");
	const root = `/browser/agents/${agent}`;
	const profile = `${root}/profile`;
	const mine = `tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "--user-data-dir=${profile} "`;
	return [
		"set -e",
		"export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"umask 077",
		`export HOME=${root}/home`,
		`for i in 1 2 3 4 5 6 7 8 9 10; do found=; for pid in $(pgrep -x chromium || true); do if ${mine}; then kill "$pid" 2>/dev/null || true; found=1; fi; done; [ -n "$found" ] || break; sleep 0.3; done`,
		`mkdir -p ${profile}/Default "$HOME/.pki/nssdb"`,
		`rm -f ${profile}/Singleton*`,
		`prefs=${profile}/Default/Preferences`,
		`if [ -s "$prefs" ] && jq -e . "$prefs" >/dev/null 2>&1; then jq '. * ${PREFERENCES}' "$prefs" > "$prefs.new"; else echo '${PREFERENCES}' > "$prefs.new"; fi`,
		'mv "$prefs.new" "$prefs"',
		'[ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password',
		'certutil -d "sql:$HOME/.pki/nssdb" -D -n banda >/dev/null 2>&1 || true',
		`certutil -d "sql:$HOME/.pki/nssdb" -A -n banda -t C,, -i ${quote(trust)}`,
		"exec 3<&0 4>&1 1>&2",
		[
			"exec chromium --headless=new --remote-debugging-pipe --no-sandbox --disable-dev-shm-usage",
			`--user-data-dir=${profile} --proxy-server=${quote(`http://${proxy}`)} --no-first-run --no-default-browser-check`,
			"--disable-background-networking --disable-component-update --disable-sync --disable-breakpad",
			"--disable-features=IsolateOrigins,site-per-process,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,AccountConsistency",
			"--disable-site-isolation-trials --password-store=basic --use-mock-keychain --window-size=1280,800",
			"--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
			"--hide-scrollbars --mute-audio about:blank",
		].join(" "),
	].join("\n");
}
