import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("every native Banda operation refuses WebViews whose bridge cannot isolate frames", async () => {
	const source = await readFile("mobile/android/app/src/main/java/app/banda/BandaPlugin.kt", "utf8");
	const operations = [...source.matchAll(/@PluginMethod\s+fun (\w+)\(call: PluginCall\)\s*\{([^\n]*\n[^\n]*)/g)];
	expect(operations.length).toBeGreaterThan(0);
	for (const [, name, start] of operations) expect(start, name).toMatch(/^\s*if \(refused\(call\)\) return/);
});

it("the Android bridge never logs pairing secrets or API payloads", async () => {
	const config = JSON.parse(await readFile("mobile/capacitor.config.json", "utf8"));
	expect(config.android.loggingBehavior ?? config.loggingBehavior).toBe("none");
});
