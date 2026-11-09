#!/usr/bin/env node
/** The minimal CLI (DESIGN.md "Clients"): `serve` runs the daemon; the other commands talk to it over loopback. */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { OpenWait, Status } from "../core/status.ts";
import { type Ask, fieldLines } from "../core/wait.ts";
import { ownerToken, readDaemonFile, resolveHome, webLink } from "../home.ts";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	version: string;
};

export const usage = `banda ${version}

usage:
  banda serve [--port <n>] [--box host]
                                     run the daemon and its web UI (default port 7787);
                                     --box host (or BANDA_BOX=host): no box, commands
                                     run on this computer without the network guard
  banda say [--thread <t>] <text>   send a message as the owner and print the messages
                                     and asks sent back until the agent is done
  banda status                      the web UI's link, chats, open asks,
                                     and parked tasks
  banda providers                   connected model providers
  banda provider login <id>         connect a provider (opens its sign-in link)
  banda provider logout <id>        disconnect a provider
  banda approve <id>                approve the effect an ask is about
  banda deny <id>                   deny it
  banda answer <id> <text>          answer a question; for one with fields, <field>=<value>
                                     for each

options:
  --home <dir>   the home (default $BANDA_HOME or ~/.banda)`;

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			home: { type: "string" },
			port: { type: "string" },
			box: { type: "string" },
			thread: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, ...rest] = positionals;
	const home = resolveHome(values.home);
	if (values.help || command === undefined) {
		console.log(usage);
		return 0;
	}
	if (command === "serve") {
		// only serve loads the daemon: the other commands are clients, quick to start
		const { startDaemon } = await import("../daemon.ts");
		const { boxKind } = await import("../box/box.ts");
		// host mode only when asked for by name: an unknown value is refused, never read as the container or as host
		const kind = boxKind(values.box ?? process.env.BANDA_BOX);
		const daemon = await startDaemon({
			home,
			boxKind: kind,
			...(values.port === undefined ? {} : { port: Number(values.port) }),
		});
		console.error(`banda ${version} serving ${home}\nweb: ${webLink(daemon.port, await ownerToken(home))}`);
		const signalled = new Promise<void>((resolve) => {
			process.once("SIGINT", resolve);
			process.once("SIGTERM", resolve);
		});
		await Promise.race([signalled, daemon.stopped]);
		await daemon.close();
		return (await daemon.stopped).failed ? 1 : 0;
	}
	if (command === "say") {
		const text = rest.join(" ");
		if (text === "") throw new Error("say needs a message");
		const lines = await stream(home, "/api/say", {
			text,
			...(values.thread === undefined ? {} : { thread: values.thread }),
		});
		for await (const line of lines as AsyncIterable<{
			message?: string;
			files?: string[];
			ask?: OpenWait;
			ended?: string;
			error?: string;
		}>) {
			if (line.message !== undefined && line.message !== "") console.log(line.message);
			for (const name of line.files ?? []) console.log(`[file: ${name}, in the app]`);
			if (line.ask !== undefined) console.error(asked(line.ask));
			if (line.error !== undefined) throw new Error(line.error);
			if (line.ended !== undefined && line.ended !== "") console.error(line.ended);
		}
		return 0;
	}
	if (command === "approve" || command === "deny" || command === "answer") {
		const [id, ...words] = rest;
		if (id === undefined) throw new Error(`${command} needs the ask's id (banda status lists them)`);
		if (command !== "answer" && words.length > 0) throw new Error(`${command} takes the ask's id, and nothing else`);
		if (command === "answer" && words.length === 0) throw new Error("answer needs the answer after the id");
		const fields = words.every((word) => /^[^=\s]+=/.test(word))
			? Object.fromEntries(words.map((word) => [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]))
			: undefined;
		// a multiple-choice ask takes its picks as one comma-separated text, which the agent reads as said
		const answer = command === "answer" ? (fields ?? words.join(" ")) : command;
		const type = command === "answer" ? "question" : "approval";
		await call(home, "POST", `/api/waits/${encodeURIComponent(id.toLowerCase())}`, { answer, via: "cli", type });
		console.log(command === "approve" ? "approved" : command === "deny" ? "denied" : "answered");
		return 0;
	}
	if (command === "status") {
		const { chats, waits, parked } = (await call(home, "GET", "/api/status")) as Status;
		const daemon = await readDaemonFile(home);
		if (daemon?.port !== undefined && daemon.token !== undefined)
			console.log(`web: ${webLink(daemon.port, daemon.token)}`);
		if (chats.length === 0) console.log("no chats");
		for (const c of chats) {
			const pending = c.unanswered === 0 ? "" : `, ${c.unanswered} unanswered`;
			const { gateway, peer, thread } = c.origin;
			console.log(`${gateway}/${peer}${thread === undefined ? "" : `/${thread}`}  #${c.chat}  ${c.state}${pending}`);
		}
		for (const w of waits) console.log(asked(w));
		for (const p of parked)
			console.log(`parked: task ${p.task} (${p.kind}) in #${p.chat}: ${p.reason.replaceAll("_", " ")}`);
		return 0;
	}
	if (command === "providers") {
		const providers = (await call(home, "GET", "/api/providers")) as {
			id: string;
			name: string;
			connected: boolean;
			connecting: boolean;
			error?: string;
		}[];
		for (const provider of providers)
			console.log(
				`${provider.id}\t${provider.connected ? "connected" : provider.connecting ? "connecting" : "not connected"}\t${provider.name}${provider.error === undefined ? "" : `: ${provider.error}`}`,
			);
		return 0;
	}
	if (command === "provider") {
		const [action, id, ...extra] = rest;
		if ((action !== "login" && action !== "logout") || id === undefined || extra.length > 0)
			throw new Error("provider needs login or logout, and a provider id");
		if (action === "logout") {
			await call(home, "DELETE", `/api/providers/${encodeURIComponent(id)}`);
			console.log(`${id} disconnected`);
			return 0;
		}
		const started = (await call(home, "POST", `/api/providers/${encodeURIComponent(id)}`, { type: "oauth" })) as {
			url?: string;
		};
		if (started.url === undefined) throw new Error(`${id} did not offer browser sign-in`);
		console.log(`Open this link to connect ${id}:\n${started.url}\n\nThen run: banda providers`);
		return 0;
	}
	console.error(usage);
	return 2;
}

/** An open ask, and the command that answers it. */
function asked({ key, ask, chat, deadline }: Pick<OpenWait, "key" | "ask"> & Partial<OpenWait>): string {
	const where = chat === undefined ? "" : ` in #${chat}`;
	const until =
		deadline === undefined
			? ""
			: `, until ${new Date(deadline).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
	return `ask ${key}${where}${until}:\n${describe(ask, key)}`;
}

function describe(ask: Ask, key: string): string {
	if (ask.type === "approval") {
		const named = ask.label ?? ask.tool;
		const what = ask.interrupted
			? `${named} was interrupted and may have partly run; run it again?`
			: `approve: ${named}?${ask.floor === undefined ? "" : " (it asks every time)"}`;
		const args = JSON.stringify(ask.args, null, 2).replace(/^/gm, "    ");
		return `  ${what}\n${args}\n  banda approve ${key} | banda deny ${key}`;
	}
	const options =
		ask.options === undefined
			? ""
			: `\n${ask.options.map((o) => `    - ${o}`).join("\n")}${ask.multiple ? "\n    (any of them, comma-separated)" : ""}`;
	const fields = ask.fields === undefined ? "" : `\n${fieldLines(ask.fields, false).replace(/^/gm, "    ")}`;
	const how =
		ask.fields === undefined
			? `banda answer ${key} <text>`
			: `banda answer ${key} ${ask.fields.map((f) => `${f.name}=…`).join(" ")}`;
	return `  ${ask.question}${options}${fields}\n  ${how}`;
}

/** POST `body` to `path` and yield each line of the newline-delimited JSON answer. */
async function* stream(home: string, path: string, body: unknown): AsyncGenerator<unknown> {
	const daemon = await readDaemonFile(home);
	if (daemon?.port === undefined || daemon.token === undefined) throw new Error(`no banda daemon runs on ${home}`);
	const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok || response.body === null) {
		const json = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(json.error ?? `HTTP ${response.status}`);
	}
	let buffered = "";
	for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
		buffered += chunk;
		let end = buffered.indexOf("\n");
		while (end >= 0) {
			yield JSON.parse(buffered.slice(0, end));
			buffered = buffered.slice(end + 1);
			end = buffered.indexOf("\n");
		}
	}
}

async function call(home: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const daemon = await readDaemonFile(home);
	if (daemon?.port === undefined || daemon.token === undefined) throw new Error(`no banda daemon runs on ${home}`);
	const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
		method,
		headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const json = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
	return json;
}

main(process.argv.slice(2)).then(
	(code) => (process.exitCode = code),
	(error: unknown) => {
		console.error(`banda: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
