import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failurePage, trouble } from "../desktop/src/trouble.ts";
import { OldHome, openStore } from "../src/core/store.ts";

const at = { home: "/Users/o/.banda", port: 7787, log: "/Users/o/.banda/daemon.log" };

describe("what the desktop app says when the daemon can't start", () => {
	it("tells a home from another build apart, by the words the store refuses it with", async () => {
		// the store's own refusal, so rewording it breaks this test rather than the app's advice
		const home = await mkdtemp(join(tmpdir(), "banda-trouble-"));
		await writeFile(join(home, "format"), "1\n");
		const refused = await openStore(home, {} as Parameters<typeof openStore>[1]).then(
			() => undefined,
			(error: unknown) => error,
		);
		await rm(home, { recursive: true, force: true });
		expect(refused).toBeInstanceOf(OldHome);
		const shown = trouble(`banda failed: ${(refused as Error).message}`, at);
		expect(shown.title).toBe("This version can't open your home");
		expect(shown.fix).toContain(at.home);
	});

	it("names a taken port, and points a generic failure at its log", () => {
		expect(trouble("Error: listen EADDRINUSE: address already in use 127.0.0.1:7787", at).title).toBe(
			"Port 7787 is taken",
		);
		const generic = trouble("something else\nentirely", at);
		expect(generic.title).toBe("banda didn't start");
		expect(generic.fix).toContain(at.log);
		expect(generic.details).toBe("something else\nentirely");
	});

	it("draws a page that runs nothing and escapes what the daemon said", () => {
		const page = failurePage({ title: "t", said: "s", fix: "f", details: "<script>alert(1)</script>" });
		expect(page).toContain("default-src 'none'");
		expect(page).not.toContain("<script>");
		expect(page).toContain("&lt;script&gt;");
	});
});
