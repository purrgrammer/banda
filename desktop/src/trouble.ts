/** What the desktop app shows when the daemon cannot start: what happened and what to do, never only a stack. */

export type Trouble = {
	readonly title: string;
	readonly said: string;
	readonly fix: string;
	/** The daemon's last words, for the curious and for a bug report. */
	readonly details?: string;
};

/** Read the daemon's output for a cause the owner can act on. */
export function trouble(output: string, at: { home: string; port: number; log: string }): Trouble {
	const tail = output.trim().split("\n").slice(-20).join("\n");
	if (/made by an earlier build of banda|is in format \d+, and this build/.test(output))
		return {
			title: "This version can't open your home",
			said: `${at.home} was made by another version of banda, and this pre-release changes how it stores things without converting them.`,
			fix: `Quit, rename ${at.home} to keep it, and start again for a fresh home; or install the version that made it.`,
			details: tail,
		};
	if (/EADDRINUSE/.test(output))
		return {
			title: `Port ${at.port} is taken`,
			said: `Another program is listening on 127.0.0.1:${at.port}, where banda serves its app.`,
			fix: "Quit that program and start banda again, or start banda with BANDA_PORT set to a free port.",
			details: tail,
		};
	if (/ENOENT/.test(output) && !/serving/.test(output))
		return {
			title: "banda's files are missing",
			said: "The app could not find the Node.js runtime or the daemon it ships with.",
			fix: "Reinstall banda from its release page.",
			details: tail,
		};
	return {
		title: "banda didn't start",
		said: "Its daemon stopped while starting.",
		fix: `Quit and start banda again. If it happens again, its output is in ${at.log}.`,
		details: tail,
	};
}

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** A page of its own, with no script and nothing fetched: it shows even when nothing else works. */
export function failurePage({ title, said, fix, details }: Trouble): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>banda</title>
<style>
:root { color-scheme: light dark; --fg: #1c1b1a; --muted: #6b6762; --bg: #faf9f7; --panel: #f0eeea; }
@media (prefers-color-scheme: dark) { :root { --fg: #ecebe8; --muted: #a29e98; --bg: #171615; --panel: #232220; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 34rem; margin: 18vh auto 0; padding: 0 16px; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
p { margin: 0 0 .75rem; }
.fix { font-weight: 600; }
details { margin-top: 1.25rem; color: var(--muted); }
pre { background: var(--panel); padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(said)}</p>
<p class="fix">${escapeHtml(fix)}</p>
${details === undefined || details === "" ? "" : `<details><summary>What it said</summary><pre>${escapeHtml(details)}</pre></details>`}
</main>
</body>
</html>`;
}
