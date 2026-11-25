/**
 * `node scripts/release-age.ts [lockfile...]`: fails when a lockfile pins a version the registry published more
 * recently than the cooldown of its tree's `.npmrc` (`min-release-age`, in days), names `min-release-age-exclude[]`
 * matches aside. npm applies the cooldown when it resolves; this holds what the lockfile keeps, so a version resolved
 * before the setting, by another npm or by hand, is found. test/supply-chain.test.ts runs it against a registry of its
 * own.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLockfile } from "./lockfile.ts";
import { getJson } from "./registry-fetch.ts";

const CONCURRENCY = 16;
const DAY = 86_400_000;

export interface Cooldown {
	days: number;
	exclude: string[];
}

/** The cooldown an `.npmrc` sets; one that sets none is an error, since every tree must. */
export function cooldown(npmrc: string, file = ".npmrc"): Cooldown {
	let days: number | undefined;
	const exclude: string[] = [];
	for (const raw of npmrc.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const at = line.indexOf("=");
		if (at < 0) continue;
		const key = line.slice(0, at).trim();
		const value = line.slice(at + 1).trim();
		if (key === "min-release-age") days = Number(value);
		if (key === "min-release-age-exclude[]") exclude.push(value);
	}
	if (days === undefined || !Number.isFinite(days) || days <= 0) throw new Error(`${file}: no min-release-age`);
	return { days, exclude };
}

/** Whether a `min-release-age-exclude` pattern (`*` matches within one path segment) names `name`. */
export function excluded(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		const source = pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join("[^/]*");
		return new RegExp(`^${source}$`).test(name);
	});
}

interface Held {
	name: string;
	version: string;
	days: number;
	from: string;
}

/** The pins the lockfiles hold to a cooldown, by `name@version`, each to the longest one a tree that pins it sets. */
export function heldPins(files: string[]): Map<string, Held> {
	const held = new Map<string, Held>();
	for (const file of files) {
		const npmrc = join(dirname(file), ".npmrc");
		const { days, exclude } = cooldown(readFileSync(npmrc, "utf8"), npmrc);
		for (const p of readLockfile(file)) {
			if (p.bundled || excluded(p.name, exclude)) continue;
			const id = `${p.name}@${p.version}`;
			const known = held.get(id);
			if (!known || known.days < days) held.set(id, { name: p.name, version: p.version, days, from: file });
		}
	}
	return held;
}

const encode = (name: string) => (name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : name);

/** Every held pin the registry at `url` published less than its cooldown before `now`, or holds no time for. */
export async function tooYoung(url: string, held: Map<string, Held>, now: Date): Promise<string[]> {
	const queue = [...held.entries()];
	const failures: string[] = [];
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const [id, p] = next;
				try {
					const doc = await getJson<{ time?: Record<string, string> }>(`${url}/${encode(p.name)}`);
					const time = doc.time?.[p.version];
					if (!time) {
						failures.push(`${id} (${p.from}): the registry has no publish time`);
						continue;
					}
					const age = (now.getTime() - new Date(time).getTime()) / DAY;
					if (!(age >= p.days))
						failures.push(
							`${id} (${p.from}): published ${time}, ${age.toFixed(1)} days ago; the cooldown is ${p.days}`,
						);
				} catch (e) {
					failures.push(`${id} (${p.from}): ${(e as Error).message}`);
				}
			}
		}),
	);
	return failures.sort();
}

if (import.meta.main) {
	const files = process.argv.length > 2 ? process.argv.slice(2) : ["package-lock.json"];
	const held = heldPins(files);
	const failures = await tooYoung("https://registry.npmjs.org", held, new Date());
	console.log(`Release age: ${held.size} packages from ${files.join(", ")}, ${failures.length} too young.`);
	for (const f of failures) console.log(`::error::${f}`);
	if (failures.length > 0) process.exit(1);
}
