import { type ValidationResult, validateAvatar } from "open-bot-avatar";
import avatarPackage from "open-bot-avatar/package.json" with { type: "json" };
// 0.2.1 exports neither ./path nor these functions from its root. Use the installed artifact explicitly,
// not an unexported package specifier or a copy of the SVG parser. This adapter is tied to the exact pin:
// upgrades must re-audit parse/flatten/serialize and the validator's raster loops before changing it.
import { bounds, flattenPath, parsePath, serializePath } from "../../node_modules/open-bot-avatar/dist/path.js";

/**
 * Upstream's raster scan costs rows × flattened points, and runs synchronously wherever a face is read. Flattening
 * is adaptive (up to 256 points an arc, 128 a curve), so the segment cap alone no longer bounds the points: this is
 * the most 0.1.2 could produce (400 segments × 24), which keeps the worst case where it was. Bundled faces use < 300.
 */
export const MAX_FACE_POINTS = 9_600;

/**
 * Bound the work BEFORE upstream's analyzeBody rasterizes. Numeric tokens do not bound SVG geometry:
 * relative commands accumulate, reflected controls move, and arc radius correction can expand tiny radii.
 * Upstream scans the serialized (rounded) path, so preflight that exact representation, not the input.
 *
 * In the pinned implementation parsing is capped at 6,000 chars / 400 segments / 16 subpaths, and flattening
 * at 256 points per segment. Once there are at most MAX_FACE_POINTS flattened points, each finite and inside
 * 6..94, every subpath's and the whole body's raster grids are bounded as well (step >= .5).
 */
export function validateBoundedAvatar(input: unknown): ValidationResult {
	const refused = refuseUnbounded(input);
	if (refused) return refused;
	try {
		return validateAvatar(input);
	} catch {
		return { ok: false, errors: ["body.path is not a valid bounded SVG path."] };
	}
}

/** The bounded checks alone, linear in the path and safe on the event loop: a refusal, or nothing to refuse. */
export function refuseUnbounded(input: unknown): { ok: false; errors: string[] } | undefined {
	if (avatarPackage.version !== "0.2.1")
		return { ok: false, errors: ["Face geometry needs review for this avatar library version."] };
	const path = (input as { body?: { path?: unknown } } | null)?.body?.path;
	if (typeof path !== "string" || path.trim() === "")
		return { ok: false, errors: ["body.path must be a non-empty SVG path."] };
	try {
		const normalized = serializePath(parsePath(path));
		const polys = flattenPath(parsePath(normalized));
		if (polys.reduce((count, poly) => count + poly.length, 0) > MAX_FACE_POINTS)
			return { ok: false, errors: ["body.path is too detailed: use fewer, simpler curves."] };
		if (
			polys.length === 0 ||
			polys.some((poly) =>
				poly.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 6 || y < 6 || x > 94 || y > 94),
			)
		)
			return { ok: false, errors: ["body.path must have finite geometry inside the safe area (6..94)."] };
		const b = bounds(polys);
		if (b.maxX <= b.minX || b.maxY <= b.minY)
			return { ok: false, errors: ["body.path must have a non-empty filled body."] };
		return undefined;
	} catch {
		return { ok: false, errors: ["body.path is not a valid bounded SVG path."] };
	}
}
