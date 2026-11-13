import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { BoxEgress, EgressConfig } from "./box.ts";
import { configPusher } from "./egress-config.ts";

export const TRUST = "/etc/ssl/certs/ca-certificates.crt";
export const TRUST_ENV = {
	SSL_CERT_FILE: TRUST,
	SSL_CERT_DIR: "/etc/ssl/certs",
	CURL_CA_BUNDLE: TRUST,
	REQUESTS_CA_BUNDLE: TRUST,
	NODE_EXTRA_CA_CERTS: TRUST,
	NODE_OPTIONS: "--use-openssl-ca",
	GIT_SSL_CAINFO: TRUST,
	PIP_CERT: TRUST,
	CARGO_HTTP_CAINFO: TRUST,
	DENO_CERT: TRUST,
	AWS_CA_BUNDLE: TRUST,
};
const LOOPBACK = "localhost,127.0.0.1,::1";
const Key = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** The daemon's login key stays beside its token, outside every box export. */
export function egressKey(home: string): string {
	const path = join(home, "auth", "egress.key");
	try {
		const key = readFileSync(path, "utf8").trim();
		if (Value.Check(Key, key)) return key;
	} catch {
		// A home without a key gets one before its proxy is configured.
	}
	mkdirSync(join(home, "auth"), { recursive: true, mode: 0o700 });
	const key = randomBytes(32).toString("hex");
	writeFileSync(path, `${key}\n`, { mode: 0o600 });
	return key;
}

export function proxyMark(key: string, chat: number): string {
	return createHmac("sha256", Buffer.from(key, "hex")).update(`banda-egress:c${chat}`).digest("hex").slice(0, 32);
}

export const browserLogin = (agent: string) => `b-${agent}`;

export function tabStamp(key: string, agent: string, chat: number): string {
	const mark = createHmac("sha256", Buffer.from(key, "hex"))
		.update(`banda-egress:t${agent}:${chat}`)
		.digest("hex")
		.slice(0, 32);
	return `${chat}.${mark}`;
}

export function browserMark(key: string, agent: string): string {
	return createHmac("sha256", Buffer.from(key, "hex"))
		.update(`banda-egress:${browserLogin(agent)}`)
		.digest("hex")
		.slice(0, 32);
}

export type ProxyTransport = {
	/** Run this complete argv inside the proxy, through its private control transport. */
	exec(args: readonly string[], input?: string, timeoutMs?: number): Promise<string>;
	running(): Promise<boolean>;
	halt(): Promise<void>;
};

const Pair = Type.Tuple([Type.String(), Type.String()]);
const Request = {
	chat: Type.Integer({ minimum: 0 }),
	at: Type.Number(),
	method: Type.String(),
	scheme: Type.Union([Type.Literal("http"), Type.Literal("https")]),
	host: Type.String(),
	port: Type.Integer({ minimum: 1, maximum: 65535 }),
	path: Type.String(),
};
const Held = Type.Object({ ...Request, ticket: Type.String(), headers: Type.Array(Pair), body: Type.String() });
const Sent = Type.Object({
	...Request,
	id: Type.String(),
	hash: Type.String(),
	bytes: Type.Integer({ minimum: 0 }),
	status: Type.Optional(Type.Integer()),
	failed: Type.Optional(Type.String()),
	reached: Type.Optional(Type.Boolean()),
});
const Taken = Type.Object({
	held: Type.Array(Held),
	sent: Type.Optional(Type.Array(Sent)),
	reads: Type.Array(Type.String()),
	readBytes: Type.Integer({ minimum: 0 }),
});
const Replayed = Type.Union([
	Type.Object({
		status: Type.Integer(),
		reason: Type.String(),
		headers: Type.Array(Pair),
		body: Type.String(),
		truncated: Type.Optional(Type.Boolean()),
	}),
	Type.Object({ refused: Type.String() }),
	Type.Object({ failed: Type.String(), reached: Type.Optional(Type.Boolean()) }),
]);
const Empty = Type.Object({}, { additionalProperties: false });
const Configured = Type.Object({ stale: Type.Optional(Type.Integer()) }, { additionalProperties: false });
const Ping = Type.Object({ up: Type.Boolean() });

async function control<T extends TSchema>(
	transport: ProxyTransport,
	schema: T,
	args: readonly string[],
	input?: unknown,
	timeoutMs = 30_000,
): Promise<Static<T>> {
	const output = await transport.exec(
		["python3", "/banda/ctl.py", ...args],
		input === undefined ? undefined : JSON.stringify(input),
		timeoutMs,
	);
	const value: unknown = JSON.parse(output.trim().split("\n").at(-1) ?? "null");
	if (!Value.Check(schema, value)) throw new Error(`Invalid proxy ${args[0]} response`);
	return value;
}

export async function proxyReady(transport: ProxyTransport): Promise<boolean> {
	return (await control(transport, Ping, ["ping"])).up;
}

/** Shared admission and receipts; only the runtime's private exec transport differs. */
export function guardedProxy({
	home,
	endpoint,
	transport,
}: {
	readonly home: string;
	readonly endpoint: string;
	readonly transport: ProxyTransport;
}) {
	const key = egressKey(home);
	let source: (() => Promise<Omit<EgressConfig, "key">>) | undefined;
	const configure = configPusher({
		running: () => transport.running(),
		read: async () => ({ key, ...(source === undefined ? {} : await source()) }),
		send: async (config, generation) => {
			const answered = await control(transport, Configured, ["config"], { ...config, generation });
			if (answered.stale !== undefined)
				throw new Error(`The proxy holds a later config (generation ${answered.stale})`);
		},
		halt: () => transport.halt(),
	});
	const egress: BoxEgress = {
		env: (chat) => {
			const url = `http://c${chat}:${proxyMark(key, chat)}@${endpoint}`;
			return {
				http_proxy: url,
				https_proxy: url,
				HTTP_PROXY: url,
				HTTPS_PROXY: url,
				ALL_PROXY: url,
				all_proxy: url,
				NO_PROXY: LOOPBACK,
				no_proxy: LOOPBACK,
				NODE_USE_ENV_PROXY: "1",
			};
		},
		source: (from) => {
			source = from;
		},
		configure,
		pass: async (chat, hash) => {
			await control(transport, Empty, ["pass", String(chat), hash]);
		},
		take: (chat) => control(transport, Taken, ["take", String(chat)]),
		receiptChats: () => control(transport, Type.Array(Type.Integer({ minimum: 0 })), ["receipts"]),
		ack: async (chat, readBytes, tickets) => {
			await control(transport, Empty, ["ack", String(chat), String(readBytes), ...tickets]);
		},
		replay: (request) => control(transport, Replayed, ["replay"], request, 120_000),
	};
	return {
		egress,
		browser: (agent: string) => ({
			login: { username: browserLogin(agent), password: browserMark(key, agent) },
			stamp: (chat: number) => tabStamp(key, agent, chat),
		}),
	};
}
