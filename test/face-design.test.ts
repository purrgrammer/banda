import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getExample } from "open-bot-avatar";
import { describe, expect, it } from "vitest";
import { AVATAR_INSTRUCTIONS, SHEET_AVATAR_INSTRUCTIONS } from "../src/core/avatar-instructions.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { DESCRIPTION_MAX, designFace } from "../src/server/face-design.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { said, scripted } from "./fixtures/scripted.ts";
import { FAUX_MODEL, tempHome } from "./helpers.ts";

const MUG = JSON.stringify(getExample("mug"));

describe("designing a face in the sheet", () => {
	it("asks with the sheet's instructions, not the chat's, and the owner's words and the agent's name", async () => {
		const { models, model, asked } = scripted(fauxAssistantMessage(`Here:\n\`\`\`json\n${MUG}\n\`\`\``));
		const designed = await designFace({ models, model, description: "a mug of tea", name: "Earl" });
		expect(designed).toMatchObject({ ok: true, value: { id: "mug" } });
		expect(said(asked[0])).toContain("Never ask a follow-up");
		expect(said(asked[0])).not.toContain("message_user");
		expect(said(asked[0])).toContain("a mug of tea");
		expect(said(asked[0])).toContain('"Earl"');
		// one set of design rules for both: only the delivery differs
		const rules = AVATAR_INSTRUCTIONS.slice(AVATAR_INSTRUCTIONS.indexOf("## Output schema"));
		expect(SHEET_AVATAR_INSTRUCTIONS.endsWith(rules)).toBe(true);
	});

	it("designs from the name alone when there is no description", async () => {
		const { models, model, asked } = scripted(fauxAssistantMessage(MUG));
		expect((await designFace({ models, model, description: " ", name: "Kettle" })).ok).toBe(true);
		expect(said(asked[0])).toContain('"Kettle"');
	});

	it("revises geometry the validator refused, and never passes on markup", async () => {
		const bad = JSON.stringify({ ...JSON.parse(MUG), html: "<script>globalThis.pwned=true</script>" });
		const revised = scripted(fauxAssistantMessage(bad), fauxAssistantMessage(MUG));
		expect((await designFace({ ...revised, description: "a mug" })).ok).toBe(true);
		expect(revised.asked).toHaveLength(2);
		const failing = scripted(fauxAssistantMessage("no face here"), fauxAssistantMessage(bad));
		expect((await designFace({ ...failing, description: "a mug" })).ok).toBe(false);
		expect(globalThis).not.toHaveProperty("pwned");
	});

	it("refuses an empty or oversized description without asking the model", async () => {
		const { models, model, asked } = scripted();
		expect(await designFace({ models, model, description: "" })).toMatchObject({ ok: false });
		expect(await designFace({ models, model, description: "x".repeat(DESCRIPTION_MAX + 1) })).toMatchObject({
			ok: false,
		});
		expect(asked).toHaveLength(0);
	});
});

describe("POST /api/faces", () => {
	it("answers the owner with a validated definition, stores nothing, and refuses with why", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: FAUX_MODEL }));
		const { models } = scripted(fauxAssistantMessage(MUG), fauxAssistantMessage("nope"), fauxAssistantMessage("nope"));
		const running = await startDaemon({
			home,
			port: 0,
			models,
			log: () => {},
			box: hostBox(home),
			web: join(home, "web"),
		});
		try {
			const token = (await readDaemonFile(home))?.token;
			const url = `http://127.0.0.1:${running.port}/api`;
			const auth = { authorization: `Bearer ${token}` };
			const post = (body: unknown, headers: Record<string, string> = auth) =>
				fetch(`${url}/faces`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			const agents = async () => (await fetch(`${url}/agents`, { headers: auth })).json();
			const before = await agents();
			const ok = await post({ description: "a mug", name: "Earl" });
			expect(ok.status).toBe(200);
			expect(await ok.json()).toMatchObject({ definition: { id: "mug" } });
			expect(await agents()).toEqual(before);
			const refused = await post({ description: "a mug" });
			expect(refused.status).toBe(400);
			expect(await refused.text()).toContain("didn't come out right");
			expect((await post({ description: 3 })).status).toBe(400);
			expect((await post({ description: "a mug" }, {})).status).toBe(401);
		} finally {
			await running.close();
		}
	});
});
