import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { fixture, run } from "./fixtures/linux-browser.ts";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

it.skipIf(!existsSync(chrome) || process.platform === "win32")(
	"preserves the shared helper's CDP descriptors through a regular Chrome renderer and removes its profile",
	async () => {
		const { output } = await fixture();
		const { status, result, log } = await run(chrome, output);
		expect(status, log).toBe(0);
		expect(result.qualification).toBe(false);
		expect(result.readiness).toMatchObject({ kind: "ready", constant: 2 });
		expect(result.helperExit).toBe("it ended (code 0)");
		expect(result.cleanup.kind).toBe("complete");
		expect(result.process.profile).not.toBeNull();
		expect(existsSync(result.process.profile ?? "")).toBe(false);
		expect(result.process.profileMetadata.kind).toBe("read");
		expect(result.process.arguments).toContain("--remote-debugging-pipe");
		if (process.platform === "linux") {
			expect(result.process.browserObservation).toBe("observed");
			expect(result.process.browser?.exe).toEqual({ kind: "read", value: result.binary.path });
		}
	},
);
