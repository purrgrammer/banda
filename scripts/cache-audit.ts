#!/usr/bin/env node
/**
 * How well a home used the provider's prompt cache, from a fork of it (`npm run home:fork -- --no-volumes`), never the
 * live home: aggregates by request class, system and provider, and no message text.
 */
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonRepresentation } from "@earendil-works/chord";
import { createModels, type Usage } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import { type AuditRow, auditCache, CACHE_WINDOW, type CacheAudit } from "../src/core/cache-audit.ts";
import { context, openStore } from "../src/core/store.ts";
import { SystemUsage } from "../src/core/system-usage.ts";
import { resolveHome } from "../src/home.ts";
import { itemOf } from "../src/server/transcript.ts";
import { startsRun } from "../web/src/lib/feed.ts";

const canonical = (path: string) => realpath(path).catch(() => resolve(path));

async function refuseLive(home: string): Promise<void> {
	const target = await canonical(home);
	for (const live of [resolveHome(), join(homedir(), ".banda")])
		if (target === (await canonical(live)))
			throw new Error(
				`${home} is the live home, which this never opens. Fork it first (npm run home:fork -- --no-volumes) and pass the fork as --home.`,
			);
}

async function conversations(harness: Harness): Promise<ConversationId[]> {
	const found: ConversationId[] = [];
	let cursor: Parameters<Tx["scanConversations"]>[2];
	do {
		const page = await harness.commit((tx) => tx.scanConversations({ order: "ascending" }, 200, cursor), context);
		found.push(...page.items.map((conversation) => conversation.id));
		cursor = page.next;
	} while (cursor !== undefined);
	return found;
}

async function rowsOf(harness: Harness, chat: ConversationId): Promise<AuditRow[]> {
	const rows: AuditRow[] = [];
	let cursor: Parameters<Tx["scanEntries"]>[2];
	do {
		const page = await harness.commit(
			(tx) => tx.scanEntries({ conversationId: chat, order: "ascending" }, 200, cursor),
			context,
		);
		for (const entry of page.items) {
			// a fork's scan includes what it inherited, and each conversation's ledger holds only its own spend
			if (entry.conversationId !== chat) continue;
			const item = itemOf(entry);
			if (item === undefined) continue;
			if (startsRun(item)) rows.push({ type: "input", chat: Number(chat) });
			else if (item.role === "assistant")
				rows.push({
					type: "request",
					chat: Number(chat),
					at: item.at ?? 0,
					model: item.model ?? "unknown/unknown",
					usage: item.usage,
				});
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return rows;
}

function addLedger(
	sum: { [model: string]: JsonRepresentation<Usage> },
	model: string,
	usage: JsonRepresentation<Usage>,
): void {
	const total = sum[model];
	if (total === undefined) {
		sum[model] = structuredClone(usage);
		return;
	}
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** The audit of the store at `home`, which must be a fork, not the live home. */
export async function auditHome(
	home: string,
	between: { readonly from?: number; readonly to?: number } = {},
	window: number = CACHE_WINDOW,
): Promise<CacheAudit> {
	const { rows, usage, ledger } = await readHome(home);
	return auditCache({ rows, usage, ledger, between, window });
}

async function readHome(home: string) {
	await refuseLive(home);
	if (!existsSync(join(home, "durable.db"))) throw new Error(`${home} holds no store`);
	const harness = await openStore(home, { models: createModels(), registry: createRegistry() });
	try {
		const rows: AuditRow[] = [];
		const ledger: { [model: string]: JsonRepresentation<Usage> } = {};
		for (const chat of await conversations(harness)) {
			rows.push(...(await rowsOf(harness, chat)));
			const spent = await harness.snapshot(UsageDoc, chat, context);
			for (const [model, usage] of Object.entries(spent?.models ?? {})) addLedger(ledger, model, usage);
		}
		return { rows, usage: await harness.snapshot(SystemUsage, context), ledger };
	} finally {
		await harness.close(context);
	}
}

const percent = (rate: number | undefined) => (rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`);

function table(rows: readonly (readonly string[])[]): string {
	const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
	return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")).join("\n");
}

function report(audit: CacheAudit): string {
	const sections = [
		"Assistant requests by class (tokens)",
		table([
			["class", "model", "requests", "read", "written", "uncached", "hit rate"],
			...audit.classes.map((line) => [
				line.class,
				line.model,
				String(line.requests),
				String(line.read),
				String(line.written),
				String(line.uncached),
				percent(line.hitRate),
			]),
		]),
		`Requests left out, no usage reported: ${audit.unreported}`,
		`Cold starts over turns: ${audit.starts.cold} of ${audit.starts.turns}`,
		"System requests no chat records (tokens)",
		table([
			["system", "model", "requests", "unreported", "read", "written", "uncached", "hit rate"],
			...audit.systems.map((line) => [
				line.system,
				line.model,
				String(line.requests),
				String(line.unreported),
				String(line.read),
				String(line.written),
				String(line.uncached),
				percent(line.hitRate),
			]),
		]),
		"Ledger minus entries, per provider: compaction and other requests with no entry",
		table([
			["provider", "input", "output", "read", "written", "cost"],
			...audit.unaccounted.map((line) => [
				line.provider,
				String(line.input),
				String(line.output),
				String(line.read),
				String(line.written),
				`$${line.cost.toFixed(4)}`,
			]),
		]),
	];
	return sections.join("\n\n");
}

const usage = `Audit a forked home's prompt cache use (Node 26)
  npm run cache:audit -- --home <dir> [--since <date>] [--until <date>] [--window <minutes>] [--json | --rows]
--home is required and must be a fork: npm run home:fork -- --no-volumes
--since and --until take any date Date.parse reads, and count only the requests between them.
--window is how long a prompt stays cached after its last use: 5 minutes unless given, 60 for the one-hour cache.
--rows prints every input and request as one JSON line, numbers only, for a closer look.`;

function windowOf(text: string | undefined): number {
	if (text === undefined) return CACHE_WINDOW;
	const minutes = Number(text);
	if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--window takes minutes, not ${text}`);
	return minutes * 60_000;
}

function dateOf(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const at = Date.parse(text);
	if (Number.isNaN(at)) throw new Error(`${text} is not a date`);
	return at;
}

async function main() {
	const { values } = parseArgs({
		options: {
			home: { type: "string" },
			since: { type: "string" },
			until: { type: "string" },
			window: { type: "string" },
			json: { type: "boolean" },
			rows: { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	if (values.help) return console.log(usage);
	if (values.home === undefined) throw new Error(usage);
	if (values.rows) {
		for (const row of (await readHome(values.home)).rows) console.log(JSON.stringify(row));
		return;
	}
	const from = dateOf(values.since);
	const to = dateOf(values.until);
	const window = windowOf(values.window);
	const audit = await auditHome(
		values.home,
		{
			...(from === undefined ? {} : { from }),
			...(to === undefined ? {} : { to }),
		},
		window,
	);
	console.log(values.json ? JSON.stringify(audit, null, 2) : report(audit));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
