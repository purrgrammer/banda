import { type ValidationResult, validateAvatar } from "open-bot-avatar";
import avatarPackage from "open-bot-avatar/package.json" with { type: "json" };
// 0.1.2 exports neither ./path nor these functions from its root. Use the installed artifact explicitly,
// not an unexported package specifier or a copy of the SVG parser. This adapter is tied to the exact pin:
// upgrades must re-audit parse/flatten/serialize and the validator's raster loops before changing it.
import { bounds, flattenPath, parsePath, serializePath } from "../../node_modules/open-bot-avatar/dist/path.js";

/**
 * Bound the work BEFORE upstream's analyzeBody rasterizes. Numeric tokens do not bound SVG geometry:
 * relative commands accumulate, reflected controls move, and arc radius correction can expand tiny radii.
 * Upstream scans the serialized (rounded) path, so preflight that exact representation, not the input.
 *
 * In the pinned implementation parsing is capped at 6,000 chars / 400 segments / 16 subpaths; flattening
 * uses at most 24 points per segment (no adaptive subdivision). Once every flattened point is finite
 * and inside 6..94, every subpath's and the whole body's raster grids are bounded as well (step >= .5).
 */
export function validateBoundedAvatar(input: unknown): ValidationResult {
	if (avatarPackage.version !== "0.1.2")
		return { ok: false, errors: ["Face geometry needs review for this avatar library version."] };
	const path = (input as { body?: { path?: unknown } } | null)?.body?.path;
	if (typeof path !== "string" || path.trim() === "")
		return { ok: false, errors: ["body.path must be a non-empty SVG path."] };
	try {
		const normalized = serializePath(parsePath(path));
		const polys = flattenPath(parsePath(normalized));
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
		return validateAvatar(input);
	} catch {
		return { ok: false, errors: ["body.path is not a valid bounded SVG path."] };
	}
}
