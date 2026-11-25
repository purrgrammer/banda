/**
 * `node scripts/osv-audit.ts [lockfile...]`: asks OSV (https://osv.dev) about every package the lockfiles install, and
 * fails when one has a published advisory. CI runs it on every change and nightly, so an advisory published after a
 * version was pinned is found without a lockfile change. An advisory accepted for now is named in ACCEPTED with why and
 * whether the acceptance holds where the package ships, reported on every run, and fails nothing; any other fails the
 * run, and so does one accepted for dev only once that package ships: a production tree installs it, or its name is in
 * a shipped set of test/production-packages.json (the web app's bundle and the desktop shell, dev to npm, ship too; any
 * version of a shipped name counts). An accepted advisory OSV no longer reports is named, so its entry can go. test/supply-chain.test.ts runs these against an OSV of its own.
 */
import { readFileSync } from "node:fs";
import { readLockfile } from "./lockfile.ts";
import { postJson } from "./registry-fetch.ts";

const BATCH = 1000;

export interface Acceptance {
	why: string;
	/** Whether the reason holds for a production tree too; when false, the advisory is open once one installs it. */
	production: boolean;
}

/** Accepted advisories, by `advisory name@version`. */
export const ACCEPTED: Record<string, Acceptance> = {
	"GHSA-g3hv-75wg-m249 minimatch@9.0.9": {
		why: "desktop/ build tooling (electron-builder's asar and universal), never shipped; the fix is minimatch 11, a major bump of that tooling",
		production: false,
	},
	"GHSA-g3hv-75wg-m249 minimatch@10.2.6": {
		why: "desktop/ build tooling (electron-builder), never shipped; the fix is minimatch 11, a major bump of that tooling",
		production: false,
	},
	"GHSA-w5hq-g745-h8pq uuid@7.0.3": {
		why: "mobile/ build tooling (the Capacitor CLI's xcode), never shipped, and banda passes it no buffer; the fix is uuid 11",
		production: false,
	},
};

export interface Audited {
	name: string;
	version: string;
	production: boolean;
}

export type Advisory = Audited & { id: string };

interface Query {
	package: { name: string; ecosystem: "npm" };
	version: string;
	page_token?: string;
}

interface BatchAnswer {
	results: { vulns?: { id: string }[]; next_page_token?: string }[];
}

/** Every package name a shipped set of the reviewed snapshot (test/production-packages.json) holds. */
export function shippedNames(file: string): Set<string> {
	const snapshot = JSON.parse(readFileSync(file, "utf8")) as unknown;
	const sets = typeof snapshot === "object" && snapshot !== null ? Object.values(snapshot) : [];
	if (sets.length === 0 || !sets.every((set) => Array.isArray(set) && set.every((n) => typeof n === "string")))
		throw new Error(`${file}: not a record of package-name lists`);
	return new Set(sets.flat() as string[]);
}

/** The packages the lockfiles install, once each, production when any lockfile installs it there or its name ships. */
export function auditedPackages(files: string[], shipped: Set<string> = new Set()): Audited[] {
	const packages = new Map<string, Audited>();
	for (const p of files.flatMap((file) => readLockfile(file))) {
		const key = `${p.name}@${p.version}`;
		const known = packages.get(key);
		const production = p.production || shipped.has(p.name) || known?.production === true;
		packages.set(key, { name: p.name, version: p.version, production });
	}
	return [...packages.values()];
}

/** Every advisory OSV at `url` (its `/v1/querybatch`) holds for the packages, following each query's next pages. */
export async function advisories(url: string, list: Audited[]): Promise<Advisory[]> {
	const found: Advisory[] = [];
	for (let i = 0; i < list.length; i += BATCH) {
		let pending = list.slice(i, i + BATCH).map((p) => ({ p, token: undefined as string | undefined }));
		while (pending.length > 0) {
			const queries: Query[] = pending.map(({ p, token }) => ({
				package: { name: p.name, ecosystem: "npm" },
				version: p.version,
				...(token === undefined ? {} : { page_token: token }),
			}));
			const body = await postJson<BatchAnswer>(url, { queries });
			if (body.results?.length !== pending.length)
				throw new Error(`OSV answered ${body.results?.length} of ${pending.length}`);
			const next: typeof pending = [];
			body.results.forEach((result, j) => {
				for (const vuln of result.vulns ?? []) found.push({ id: vuln.id, ...pending[j].p });
				if (result.next_page_token) next.push({ p: pending[j].p, token: result.next_page_token });
			});
			pending = next;
		}
	}
	return found;
}

export interface Classified {
	open: Advisory[];
	accepted: (Advisory & { why: string })[];
	/** ACCEPTED keys OSV no longer reports. */
	stale: string[];
}

export function classify(found: Advisory[], accepted: Record<string, Acceptance> = ACCEPTED): Classified {
	const key = (f: Advisory) => `${f.id} ${f.name}@${f.version}`;
	const covers = (f: Advisory) => {
		const entry = accepted[key(f)];
		return entry !== undefined && (entry.production || !f.production) ? entry : undefined;
	};
	const seen = new Set(found.map(key));
	return {
		open: found.filter((f) => covers(f) === undefined),
		accepted: found.flatMap((f) => {
			const entry = covers(f);
			return entry === undefined ? [] : [{ ...f, why: entry.why }];
		}),
		stale: Object.keys(accepted)
			.filter((k) => !seen.has(k))
			.sort(),
	};
}

if (import.meta.main) {
	const files = process.argv.length > 2 ? process.argv.slice(2) : ["package-lock.json"];
	const list = auditedPackages(files, shippedNames("test/production-packages.json"));
	const found = await advisories("https://api.osv.dev/v1/querybatch", list);
	const { open, accepted, stale } = classify(found);
	console.log(
		`OSV: ${list.length} packages from ${files.join(", ")}, ${found.length} advisories, ${open.length} open.`,
	);
	const where = (f: Advisory) =>
		`${f.name}@${f.version} (${f.production ? "production" : "dev"}) https://osv.dev/vulnerability/${f.id}`;
	for (const f of accepted) console.log(`::warning::${f.id} ${where(f)}, accepted: ${f.why}`);
	for (const f of open)
		console.log(
			`::error::${f.id} ${where(f)}${ACCEPTED[`${f.id} ${f.name}@${f.version}`] ? ", accepted for dev only" : ""}`,
		);
	for (const k of stale) console.log(`::notice::${k} is no longer reported: remove it from ACCEPTED`);
	if (open.length > 0) process.exit(1);
}
