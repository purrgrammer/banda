/**
 * Run counts for property suites. A property passes its baseline to `pbtRuns`, and `BANDA_PBT_RUNS` multiplies it
 * (`BANDA_PBT_RUNS=20 npm test` for a deep pass), so suites of very different cost keep their ratio. Fault-injection
 * suites use `pbtFaultRuns`, scaled by `BANDA_PBT_FAULT_RUNS` when set and by `BANDA_PBT_RUNS` otherwise: their
 * rare paths only show at depth, so they can be run deeper on their own.
 */
function scale(raw: string | undefined, fallback: number): number {
	const n = Number(raw);
	return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

const SCALE = scale(process.env.BANDA_PBT_RUNS, 1);
const FAULT_SCALE = scale(process.env.BANDA_PBT_FAULT_RUNS, SCALE);

export const pbtRuns = (base: number): number => Math.max(1, Math.round(base * SCALE));
/** A property's time budget: `ms` at the baseline run count, scaled as `pbtRuns` scales its runs. */
export const pbtTimeout = (ms: number): number => Math.round(ms * SCALE);
export const pbtFaultRuns = (base: number): number => Math.max(1, Math.round(base * FAULT_SCALE));
