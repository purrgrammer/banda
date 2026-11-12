import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Every tile on Connections is a service banda can connect to now: nothing is drawn as not shipped yet.
it("no service is shown as coming soon", () => {
	expect(readFileSync(new URL("./Catalogue.tsx", import.meta.url), "utf8")).not.toMatch(/coming soon/i);
});
