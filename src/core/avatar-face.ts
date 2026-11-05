import { type AvatarDefinition, getExample } from "open-bot-avatar";
import { validateBoundedAvatar } from "./avatar-geometry.ts";

/** A face's shape and colour, kept together in the agent's definition. */
export type AvatarFace = { readonly definition: AvatarDefinition; readonly color: string };

/** A default is copied into the agent file, not a reference to a mutable gallery entry. */
export function defaultAvatarFace(): AvatarFace {
	const definition = getExample("chat");
	if (!definition) throw new Error("The default avatar is missing");
	const checked = validateBoundedAvatar(definition);
	if (!checked.ok) throw new Error(`The default avatar is invalid: ${checked.errors.join(", ")}`);
	return { definition: checked.value, color: "#8a9cc7" };
}

/** Decode a bounded frontmatter scalar. Geometry is data, never markup or executable code. */
export function readAvatarFace(text: string): { ok: true; face: AvatarFace } | { ok: false; errors: string[] } {
	if (text.length > 16_384 || new TextEncoder().encode(text).byteLength > 16_384)
		return { ok: false, errors: ["A face is at most 16 KB."] };
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		return { ok: false, errors: ["A face must be a JSON object."] };
	}
	if (!input || typeof input !== "object" || Array.isArray(input))
		return { ok: false, errors: ["A face must be an object."] };
	const record = input as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "definition" && key !== "color"))
		return { ok: false, errors: ["A face contains only definition and color."] };
	if (typeof record.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(record.color))
		return { ok: false, errors: ["A face colour must be a six-digit hex colour."] };
	const result = validateBoundedAvatar(record.definition);
	if (!result.ok) return { ok: false, errors: result.errors };
	return { ok: true, face: { definition: result.value, color: record.color.toLowerCase() } };
}

export function writeAvatarFace(face: AvatarFace): string {
	return JSON.stringify(face);
}
