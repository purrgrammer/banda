/** A home is marked with the format of its stored shapes; a home of another, or an unmarked old one, is refused. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, HOME_FORMAT, OldHome, openStore } from "../src/core/store.ts";
import { echoModels } from "./fixtures/models.ts";
import { tempHome } from "./helpers.ts";

const open = (home: string) => openStore(home, { registry: createRegistry(), models: echoModels().models });

describe("home format", () => {
	it("marks a new home and opens it again", async () => {
		const home = await tempHome();
		await (await open(home)).close(context);
		await (await open(home)).close(context);
	});

	it("refuses a home of another format, or an old one with no mark, plainly", async () => {
		const other = await tempHome();
		await writeFile(join(other, "format"), `${HOME_FORMAT - 1}\n`);
		await expect(open(other)).rejects.toThrow(OldHome);
		const unmarked = await tempHome();
		await writeFile(join(unmarked, "durable.db"), "");
		await expect(open(unmarked)).rejects.toThrow(/earlier build of banda/);
	});
});
