/**
 * A manual run of the app (AGENTS.md "Never touch a live banda"): a daemon on a throwaway home and port 7788, never
 * ~/.banda. With ANTHROPIC_API_KEY in the environment (`node --env-file=.env test/smoke/serve.ts`) it runs the real
 * model in the container box; without, pi-ai's faux echo model in a host folder under the throwaway home. It prints the
 * app's link, and when Google Chrome is installed, takes headless screenshots at desktop and phone width into the home.
 * Build the app first: `npm run build:web`. Ctrl-C stops it.
 */
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { startDaemon } from "../../src/daemon.ts";
import { readDaemonFile, webLink } from "../../src/home.ts";
import { WEB } from "../../src/server/http.ts";
import { demoEffects } from "../fixtures/effects.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { hasChrome, withPage } from "./chrome.ts";

const PORT = Number(process.env.BANDA_SMOKE_PORT ?? 7788);

/** A PNG of one colour, 600 by 400: wider than a message shows an image. */
function picture(rgb: readonly [number, number, number]): Buffer {
	const [width, height] = [600, 400];
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const framed = Buffer.alloc(body.length + 8);
		framed.writeUInt32BE(data.length, 0);
		body.copy(framed, 4);
		framed.writeUInt32BE(crc32(body), body.length + 4);
		return framed;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	// each row: no filter, then its pixels
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(rgb))]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * The faux model for a run without a key: it answers `re: <message>` with message_user, and acts on a few words so
 * every card can be tried: "ask" a question with options, "pick" several, "form" a form, "read" a file first (a
 * working line), "file" a message with a file, "make a picture" an artifact that is an image, "remind" a routine every minute,
 * and a routine's wake its reply (none when its ask says "quiet"; a failed run when it says "fail"); "always <fact>" keeps
 * a global fact, "note <fact>" one for this agent, "about <person> <fact>" one about someone else
 * for a task, and "recall <words>" finds facts and answers naming them as what shaped it; "tell <name>" drafts a message
 * to them and "pay" a payment (on the floor), the demo effects of test/fixtures/effects.ts, which only the smoke run has.
 */
function scripted() {
	const faux = fauxProvider({ tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (context: { messages: readonly { role: string; content: unknown }[] }) => {
		// a section that changed comes as a system message after the owner's
		const last = context.messages.filter((message) => message.role !== "system").at(-1);
		// a group member speaks to its room with message_group, offered in place of message_user
		const offered = context.messages.flatMap((message) =>
			message.role === "system"
				? ((message as { toolsAdded?: readonly { name: string }[] }).toolsAdded ?? []).map((tool) => tool.name)
				: [],
		);
		const speak = offered.includes("message_group") ? "message_group" : "message_user";
		const call = (args: object) =>
			fauxAssistantMessage([fauxToolCall(speak, args as never)], { stopReason: "toolUse" });
		const result = last?.role === "toolResult" ? JSON.stringify(last.content) : "";
		if (result.includes("Found for"))
			return call({
				text: "Going by what I know of you, the 10:40 with a window seat.",
			});
		if (/Remembered|Wrote \[|Already/.test(result)) return call({ text: "Noted." });
		if (/Sent to|Paid/.test(result)) return call({ text: "Done." });
		if (/Proposed:|already waits/.test(result)) return fauxAssistantMessage("Proposed.");
		if (/Not proposed/.test(result)) return call({ text: "I won't ask that again." });
		if (/did not run/.test(result)) return call({ text: "Understood, I did not." });
		if (last?.role !== "user") return fauxAssistantMessage("Done.");
		const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
		const tool = (name: string, args: object) =>
			fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
		const said = text.replace(/^"|"$/g, "");
		if (/^always /i.test(said)) return tool("remember", { fact: said.slice(7), scope: "global" });
		if (/^note /i.test(said)) return tool("remember", { fact: said.slice(5), scope: "agent" });
		if (/^about /i.test(said)) {
			const [, who = "", fact = ""] = /^about (\S+) (.*)$/i.exec(said) ?? [];
			return tool("remember", { fact, about: who, task: "dinner on Friday", scope: "agent" });
		}
		if (/^recall /i.test(said)) return tool("recall", { query: said.slice(7) });
		if (/^"?(Your routine|The owner asked your routine)/.test(text)) {
			if (/\bquiet\b/i.test(text)) return fauxAssistantMessage("Nothing worth saying this time.");
			if (/\bfail\b/i.test(text))
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "the model is down" });
			return call({ text: `Routine ${/routine \\?"([^"\\]+)/.exec(text)?.[1] ?? ""}: here is what I found.` });
		}
		if (/\bremind\b/i.test(text))
			return fauxAssistantMessage(
				[
					fauxToolCall("schedule", {
						name: "stretch",
						description: "A nudge to stretch",
						every: "1m",
						ask: "Remind the owner to stand up and stretch.",
					}),
					fauxToolCall("message_user", { text: "I set up a routine for that; allow it." }),
				],
				{ stopReason: "toolUse" },
			);

		if (/\bpay\b/i.test(text)) return tool("pay", { to: "Lisbon Hostel", amount: "84 EUR" });
		if (/\btell (\w+)/i.test(text))
			return tool("send_message", {
				to: `${/\btell (\w+)/i.exec(text)?.[1]?.toLowerCase()}@example.com`,
				text: "Running ten minutes late, sorry!",
			});
		// "plain": the run ends in its notes alone, as a model that forgets message_user does; nudged, it answers
		if (text.includes("without answering the owner"))
			return call({ text: "Sorry, here it is: I answered only in my notes, which you never see." });
		if (/\bplain\b/i.test(text)) return fauxAssistantMessage("The answer, in my notes alone.");
		if (/\bask\b/i.test(text))
			return call({ text: "One thing first.", question: "Tea or coffee?", options: ["Tea", "Coffee"] });
		if (/\bpick\b/i.test(text))
			return call({ question: "Which checks?", options: ["unit", "fault", "audit"], multiple: true });
		if (/\bform\b/i.test(text))
			return call({
				question: "Where should I export it?",
				fields: [
					{ name: "bucket", hint: "the folder" },
					{ name: "days", type: "number" },
					{ name: "public", type: "boolean" },
				],
			});
		// "slow" works for a while, "thanks" is answered by a reaction
		if (/\bslow\b/i.test(text))
			return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 90; echo slept" })], {
				stopReason: "toolUse",
			});
		if (/\bthanks\b/i.test(text)) return call({ reaction: "👍" });
		if (/\bread\b/i.test(text))
			return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 3; echo read" })], { stopReason: "toolUse" });
		// an artifact that is an image: "make a picture", then "change the picture" for its next version
		const pictured = /\b(make a|change the) picture\b/i.exec(text);
		if (pictured !== null) {
			const change = /change/i.test(pictured[1] ?? "");
			const bytes = picture(change ? [0xd9, 0x8f, 0x6a] : [0x9d, 0xb0, 0xc6]).toString("base64");
			return fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: `printf '%s' '${bytes}' | base64 -d > coast.png` }),
					fauxToolCall("publish", { path: "coast.png", title: "Coast", ...(change ? { change: "at sunset" } : {}) }),
					fauxToolCall("message_user", { text: change ? "Now at sunset." : "Here is the picture." }),
				],
				{ stopReason: "toolUse" },
			);
		}
		// artifacts: "make a plan", "change the plan", "make a table", "make a page", each published to the Library
		const made = /\b(make a|change the) (plan|table|page)\b/i.exec(text);
		if (made !== null) {
			const kind = made[2]?.toLowerCase() as "plan" | "table" | "page";
			const change = /change/i.test(made[1] ?? "");
			const file = { plan: "lisbon-trip.md", table: "flats.csv", page: "budget.html" }[kind];
			const bytes = {
				plan: `# Friday\\n\\n- 09:10 Porto → Lisbon, Alfa Pendular\\n${change ? `- 18:40 Lisbon → Porto, back at ${new Date().toISOString().slice(11, 16)}\\n` : ""}`,
				table: 'flat,area,rooms,price\\n"Rua das Flores, 12",Ribeira,2,1450\\nTravessa do Carregal,Cedofeita,1,980\\n',
				page: "<h1>Budget</h1><p style='color:#b45309'>Rent takes most of it.</p><script>fetch('/api/chats')</script>",
			}[kind];
			return fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: `printf '%b' "${bytes.replace(/"/g, '\\"')}" > ${file}` }),
					fauxToolCall("publish", {
						path: file,
						title: { plan: "Lisbon trip plan", table: "Flat prices", page: "Budget page" }[kind],
						...(change ? { change: "added the return train" } : {}),
					}),
					fauxToolCall("message_user", { text: change ? "I added the train back." : `Here is the ${kind}.` }),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (/\bfile\b/i.test(text))
			return fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "printf 'hello' > note.txt" }),
					fauxToolCall("message_user", { text: "Here it is.", files: ["note.txt"] }),
				],
				{ stopReason: "toolUse" },
			);
		return call({ text: `re: ${text}` });
	};
	faux.setResponses(Array.from({ length: 10_000 }, () => respond as never));
	return models;
}

if (!existsSync(join(WEB, "index.html"))) {
	console.error("the app is not built: npm run build:web");
	process.exit(1);
}
const home = await mkdtemp(join(tmpdir(), "banda-smoke-"));
const real = process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY !== "";
if (!real)
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
const daemon = await startDaemon({
	home,
	port: PORT,
	...(real ? {} : { models: scripted(), box: hostBox(home) }),
	effects: demoEffects((ran) => console.error(`effect ran: ${JSON.stringify(ran)}`)),
	log: (line) => console.error(line),
});
const { token } = (await readDaemonFile(home)) ?? {};
const link = webLink(daemon.port, token ?? "");
console.log(`home:  ${home}`);
console.log(`model: ${real ? "the configured default (a key is set)" : "faux echo"}`);
console.log(`app:   ${link}`);

if (hasChrome()) {
	for (const [name, size] of [
		["desktop", { width: 1280, height: 800 }],
		["phone", { width: 390, height: 844 }],
	] as const) {
		const file = join(home, `${name}.png`);
		await withPage(link, size, async (page) => {
			await page.until("document.querySelector('main, [data-slot=sidebar-inset]')");
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await page.shoot(file);
		}).catch((error: Error) => console.error(`screenshot ${name}: ${error.message}`));
		console.log(`shot:  ${file}`);
	}
}

const stop = () => void daemon.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
