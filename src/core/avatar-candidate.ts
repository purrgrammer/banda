import type { AvatarDefinition } from "open-bot-avatar";
import { validateBoundedAvatar } from "./avatar-geometry.ts";

/** A candidate is data only. Cap bytes before parsing or handing geometry to the renderer. */
export function avatarCandidate(
	text: string,
): { ok: true; definition: AvatarDefinition } | { ok: false; errors: string[] } {
	if (text.length > 16_384 || new TextEncoder().encode(text).byteLength > 16_384)
		return { ok: false, errors: ["The face definition is too large (16 KB maximum)."] };
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		return { ok: false, errors: ["Paste a valid JSON face definition."] };
	}
	const result = validateBoundedAvatar(input);
	return result.ok ? { ok: true, definition: result.value } : { ok: false, errors: result.errors };
}
