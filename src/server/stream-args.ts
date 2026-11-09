/** Append a substrate string delta at its existing JSON path, immutably. No prototype lookup or path creation. */
export function appendArgument(value: unknown, path: readonly (string | number)[], delta: string): unknown {
	if (path.length === 0) return typeof value === "string" ? value + delta : value;
	const [key, ...rest] = path;
	if (key === undefined || typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return value;
	if (Array.isArray(value)) {
		if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key >= value.length) return value;
		return value.map((item, index) => (index === key ? appendArgument(item, rest, delta) : item));
	}
	const object = value as Record<string, unknown>;
	return { ...object, [key]: appendArgument(object[key], rest, delta) };
}
