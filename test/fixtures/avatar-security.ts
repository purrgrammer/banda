/** Run only in a killable child: a regression must never enter upstream's unbounded raster scan in Vitest. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { examples } from "open-bot-avatar";
import { openBox } from "../../src/box/box.ts";
import { Accepted, acceptedAgent, agentPath, parseAgent, shaOf } from "../../src/core/agents.ts";
import { avatarCandidate } from "../../src/core/avatar-candidate.ts";
import { defaultAvatarFace, readAvatarFace, writeAvatarFace } from "../../src/core/avatar-face.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore } from "../../src/core/turn.ts";
import { accept, agents, save, seed, type Workspace } from "../../src/server/agents.ts";
import { validFace, validPicks } from "../../src/server/companion.ts";
import { pbtRuns } from "../pbt.ts";
import { hostBox } from "./host-box.ts";
import { echoModels, FAUX_MODEL } from "./models.ts";

const home = process.argv[2];
assert(home);
const face = defaultAvatarFace();
const file = (path: string) =>
	`---\nname: Mira\nface: ${writeAvatarFace({ ...face, definition: { ...face.definition, body: { path } } })}\ndescription: Plans trips\n---\nBe practical.\n`;
const paths = [
	"M10 10A.01 120 45 0 1 90 90Z", // corrected radii: ~480,040 squared cells, despite bounded numeric tokens
	"m10 10a.01 120 45 0 1 80 80z",
	"M10 10A.014 120 45 0 1 90 90Z", // preflight must inspect the library's rounded serialization
	"M10 10A120 .01 -45 1 0 90 90Z",
	"M10 10l80 0 80 0 0 80z", // relative coordinates accumulate, not independent bounded numbers
	"M10 10Q90 90 90 10T90 90Z", // reflected controls can escape the input coordinate range
	"M10 10A1e-300 120 1e308 0 1 90 90Z",
	"",
	" ",
	"M10 10Z",
	"M10 10L90 90Z",
];
function assertRefused(path: string): void {
	const candidate = { ...face.definition, body: { path } };
	const value = { ...face, definition: candidate };
	assert.equal(avatarCandidate(JSON.stringify(candidate)).ok, false, path);
	assert.equal(readAvatarFace(JSON.stringify(value)).ok, false, path);
	assert("errors" in parseAgent("mira", file(path)), path);
	assert.throws(() => validFace(value), /body.path/);
	assert.throws(() => validPicks({ face: value }), /body.path/);
}
for (const path of paths) assertRefused(path);
fc.assert(
	fc.property(
		fc.integer({ min: 20, max: 120 }),
		fc.integer({ min: 15, max: 75 }),
		fc.boolean(),
		fc.boolean(),
		fc.boolean(),
		(radius, rotation, large, sweep, relative) => {
			const arc = `${relative ? "a" : "A"}.01 ${radius} ${rotation} ${Number(large)} ${Number(sweep)}`;
			assertRefused(`M10 10${arc} ${relative ? "80 80" : "90 90"}Z`);
		},
	),
	{ numRuns: pbtRuns(50) },
);
// Preserve the full upstream command set and ordinary faces, not a regex allowlist of simple silhouettes.
for (const definition of examples) assert.equal(avatarCandidate(JSON.stringify(definition)).ok, true, definition.id);
const relative = "m10 10h80v80h-80z";
assert.equal(avatarCandidate(JSON.stringify({ ...face.definition, body: { path: relative } })).ok, true);

const box = openBox(hostBox(home), () => {});
const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
	gateway: () => {
		throw new Error("this test never sends messages");
	},
	model: () => FAUX_MODEL,
});
const registry = createRegistry();
registry.install(core.extension);
const harness = await openStore(home, { models: echoModels().models, registry });
const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
const changed = async () => {};
try {
	await seed(harness, workspace);
	const original = file(face.definition.body.path);
	await save(harness, workspace, "mira", original, null, changed);
	for (const path of paths) {
		const proposal = file(path);
		await writeFile(join(box.workspace, agentPath("mira")), proposal);
		const row = (await agents(harness, workspace)).find((row) => row.name === "mira");
		assert(row?.change && "errors" in row.change, path);
		assert.equal(row.accepted?.agent?.face.definition.body.path, face.definition.body.path);
		await assert.rejects(accept(harness, workspace, "mira", shaOf(proposal), changed), /face/);
		await assert.rejects(save(harness, workspace, "bad", proposal, null, changed), /face/);
		assert.equal((await harness.snapshot(Accepted, context))?.files[agentPath("mira")]?.text, original);
		assert.deepEqual((await harness.commit((tx) => acceptedAgent(tx, "mira"), context))?.face, face);
	}
} finally {
	await harness.close(context);
	await box.close();
}
console.log("avatar security boundaries passed");
