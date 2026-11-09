import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { pageDocument } from "../web/src/lib/artifacts.ts";

const run = promisify(execFile);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

it.skipIf(!existsSync(chrome))(
	"runs inline page controls without granting the frame its parent's origin or a network",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "banda-artifact-preview-"));
		let hits = 0;
		const server = createServer((_request, response) => {
			hits++;
			response.end("unexpected request");
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("probe server did not listen");
			const url = `http://127.0.0.1:${address.port}`;
			const document =
				pageDocument(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src *; script-src 'unsafe-inline'"><button onclick="document.body.dataset.pressed='yes'">Choose</button><a href="${url}/outside">Outside</a><script>
				document.querySelector('button').click();
				document.querySelector('a').click();
				let parentRead = 'allowed', topNav = 'allowed';
				try { void parent.document.title; } catch { parentRead = 'blocked'; }
				try { top.location.href = '${url}/escape'; } catch { topNav = 'blocked'; }
				fetch('${url}/api/escape').then(() => parent.postMessage('network-allowed', '*')).catch(() => parent.postMessage('network-blocked', '*'));
				parent.postMessage([document.body.dataset.pressed, parentRead, topNav].join(':'), '*');
			</script>`);
			// The embedded HTML is a JS string in a parent <script>: escape its closing tags for the HTML parser.
			const encoded = JSON.stringify(document).replaceAll("</", "<\\/");
			const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="frame-src 'none'"><output id="result">waiting</output><script>
				addEventListener('message', event => { if (event.source === frame.contentWindow) document.querySelector('#result').textContent += ' ' + event.data; });
				const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.srcdoc = ${encoded}; document.body.append(frame);
			</script>`;
			const path = join(dir, "preview.html");
			await writeFile(path, html);
			const { stdout } = await run(
				chrome,
				[
					"--headless=new",
					"--no-first-run",
					"--disable-gpu",
					"--disable-background-networking",
					`--user-data-dir=${join(dir, "chrome")}`,
					"--virtual-time-budget=1500",
					"--dump-dom",
					`file://${path}`,
				],
				{ timeout: 15_000 },
			);
			const result = stdout.match(/<output id="result">([^<]*)<\/output>/)?.[1];
			expect(result).toContain("yes:blocked:blocked");
			expect(result).toContain("network-blocked");
			expect(result).not.toContain("network-allowed");
			expect(hits).toBe(0);
		} finally {
			if (server.listening) {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			await rm(dir, { recursive: true, force: true });
		}
	},
	20_000,
);
