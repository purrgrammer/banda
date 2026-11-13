/**
 * How long checking a hostile face takes, for the re-audit every open-bot-avatar upgrade needs (docs/agents.md).
 * Each path fills the parser's caps (6,000 characters, 400 segments) with large curves behind fifteen thin subpaths,
 * the shape that makes upstream's raster scan slowest; the "within" rows stop at banda's point budget, the slowest a
 * face that is not refused can be. `banda` is validateBoundedAvatar, which a face's every read runs on the event loop;
 * `upstream` is the library's validateAvatar alone, what the budget saves.
 *
 *   npm run avatar:bench                  this checkout
 *   node scripts/avatar-bench.ts <root>   another checkout's src and node_modules, as a baseline
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = pathToFileURL(`${resolve(process.argv[2] ?? `${import.meta.dirname}/..`)}/`);
const at = (path: string) => new URL(path, root).href;
const { validateBoundedAvatar } = await import(at("src/core/avatar-geometry.ts"));
const { getExample, validateAvatar } = await import(at("node_modules/open-bot-avatar/dist/index.js"));
const { parsePath, flattenPath, serializePath } = await import(at("node_modules/open-bot-avatar/dist/path.js"));
const pin = await import(at("node_modules/open-bot-avatar/package.json"), { with: { type: "json" } });
const geometry = await import(at("src/core/avatar-geometry.ts"));
const budget: number = geometry.MAX_FACE_POINTS ?? Number.POSITIVE_INFINITY;

const RUNS = 9;
const thin = Array.from({ length: 15 }, (_, i) => `M${8 + i * 5} 6h2v88h-2z`).join("");
const points = (path: string): number =>
	flattenPath(parsePath(serializePath(parsePath(path)))).reduce((n: number, poly: unknown[]) => n + poly.length, 0);

function fill(start: string, unit: string, most = Number.POSITIVE_INFINITY): string {
	let path = thin + start;
	for (;;) {
		const next = path + unit;
		try {
			if (next.length > 6000 || serializePath(parsePath(next)).length > 6000 || points(next) > most) return path;
		} catch {
			return path;
		}
		path = next;
	}
}

function time(check: (face: unknown) => { ok: boolean; errors?: string[] }, face: unknown) {
	const runs: number[] = [];
	let outcome = "";
	for (let i = 0; i < RUNS; i++) {
		const start = performance.now();
		const result = check(face);
		runs.push(performance.now() - start);
		outcome = result.ok ? "accepted" : (result.errors?.[0] ?? "refused");
	}
	runs.sort((a, b) => a - b);
	return { median: runs[RUNS >> 1] ?? 0, max: runs[RUNS - 1] ?? 0, outcome };
}

const arcs = ["M50 10", "a40 40 0 1 1-.1 0a40 40 0 1 0 .1 0"] as const;
const cubics = ["M10 50", "c0-40 80-40 80 0c0 40-80 40-80 0"] as const;
const quads = ["M10 50", "q40-40 80 0q-40 40-80 0"] as const;
const paths: Record<string, string> = {
	bundled: getExample("chat").body.path,
	arcs: fill(...arcs),
	cubics: fill(...cubics),
	quads: fill(...quads),
	"arcs within budget": fill(...arcs, budget),
	"cubics within budget": fill(...cubics, budget),
};

const ms = (n: number) => `${n.toFixed(0).padStart(4)} ms`;
console.log(`open-bot-avatar ${pin.default.version}, point budget ${budget}, median and max of ${RUNS} runs`);
for (const [name, path] of Object.entries(paths)) {
	const face = { ...getExample("chat"), body: { path } };
	const banda = time(validateBoundedAvatar, face);
	const upstream = time(validateAvatar, face);
	console.log(
		`${name.padEnd(21)} ${String(points(path)).padStart(6)} points  banda ${ms(banda.median)} (max ${ms(banda.max)})  upstream ${ms(upstream.median)}  ${banda.outcome.slice(0, 40)}`,
	);
}
