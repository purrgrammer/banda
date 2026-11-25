/** How a command reaches the daemon of its home: its port and token from `daemon.json`, a Bearer request on loopback. */
import { readDaemonFile } from "../home.ts";

export type Daemon = { readonly port: number; readonly token: string };

/** The daemon `home` runs, or why none answers there. */
export async function daemonOf(home: string): Promise<Daemon> {
	const daemon = await readDaemonFile(home);
	if (daemon?.port === undefined || daemon.token === undefined) throw new Error(`no banda daemon runs on ${home}`);
	return { port: daemon.port, token: daemon.token };
}

/** A daemon's refusal: its words, its HTTP status, and the fixed word it answered beside them, if any. */
export class Refused extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(message: string, status: number, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** A request to `home`'s daemon at `path` (`/api/...`), JSON in and out; its refusal is thrown in its words. */
export async function call(home: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const daemon = await daemonOf(home);
	const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
		method,
		headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const json = (await response.json()) as { error?: string; code?: string };
	if (!response.ok) throw new Refused(json.error ?? `HTTP ${response.status}`, response.status, json.code);
	return json;
}
