/**
 * The first agent's picks as the app shows them: its name, face, personality and how hard new chats think. The picks
 * are stored (`Companion`); the face and personality are read from the lead's accepted file.
 */
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { Accepted, agentPath, LEAD, parseAgent } from "../core/agents.ts";
import { type AvatarFace, readAvatarFace, writeAvatarFace } from "../core/avatar-face.ts";
import { DEFAULT_FACE, DEFAULT_NAME, personalityOf, personalityWords, withPersonality } from "../core/choices.ts";
import { Companion, setCompanion } from "../core/companion.ts";
import { Control } from "../core/routines.ts";
import { context } from "../core/store.ts";
import { DEFAULT_TIER, isTier, TIERS, type Tier } from "../core/tiers.ts";
import { type AgentChanged, save, type Workspace } from "./agents.ts";
import type { CompanionView } from "./api.ts";
import { BadRequest } from "./http.ts";

/** The longest name the companion may have. */
export const MAX_NAME = 40;

/** The first agent's picks now, from the store alone (defaults where none), and the lead's personality. */
export async function companion(harness: Harness, ctx: Context = context): Promise<CompanionView> {
	const picks = (await harness.snapshot(Companion, ctx)) ?? {};
	const paused = (await harness.snapshot(Control, ctx))?.paused;
	const lead = (await harness.snapshot(Accepted, ctx))?.files[agentPath(LEAD)];
	const personality = lead === undefined ? undefined : personalityOf(lead.text);
	const parsed = lead === undefined ? undefined : parseAgent(LEAD, lead.text);
	return {
		name: picks.name ?? DEFAULT_NAME,
		face: parsed !== undefined && "agent" in parsed ? parsed.agent.face : DEFAULT_FACE,
		...(personality === undefined ? {} : { personality }),
		tier: picks.tier ?? DEFAULT_TIER,
		...(paused === undefined ? {} : { paused }),
	};
}

/** `name` as the companion's, or why it cannot be: 1 to 40 characters once trimmed, none of them control characters. */
export function validName(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "") throw new BadRequest("a name needs at least one letter");
	if ([...trimmed].length > MAX_NAME) throw new BadRequest(`a name is at most ${MAX_NAME} characters`);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
	if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) throw new BadRequest("a name is one line of plain characters");
	return trimmed;
}

/** Decode the same bounded data shape accepted in agent files; never accept SVG markup. */
export function validFace(face: unknown): AvatarFace {
	let text: string | undefined;
	try {
		text = JSON.stringify(face);
	} catch {
		throw new BadRequest("a face must be a JSON object");
	}
	const checked = readAvatarFace(text ?? "null");
	if (!checked.ok) throw new BadRequest(checked.errors.join("\n"));
	return checked.face;
}

/** What `PUT /api/companion` may change, each optional. */
export type CompanionPicks = {
	/** The accepted agent revision observed by an editor; absent on first-run picks. */
	readonly base?: string;
	readonly name?: string;
	readonly face?: AvatarFace;
	/** How it speaks, in the owner's words. */
	readonly personality?: string;
	/** The tier new chats start on. */
	readonly tier?: Tier;
};

/** A request's body as picks, or why it is not: every field given must be valid. */
export function validPicks(body: Record<string, unknown>): CompanionPicks {
	const picks: { base?: string; name?: string; face?: AvatarFace; personality?: string; tier?: Tier } = {};
	if (body.base !== undefined) {
		if (typeof body.base !== "string" || !/^[a-f0-9]{64}$/.test(body.base))
			throw new BadRequest("base is the accepted agent revision you saw");
		picks.base = body.base;
	}
	if (body.tier !== undefined) {
		if (!isTier(body.tier)) throw new BadRequest(`tier is how hard it thinks: ${TIERS.join(", ")}`);
		picks.tier = body.tier;
	}
	if (body.name !== undefined) {
		if (typeof body.name !== "string") throw new BadRequest("name is the companion's name, as text");
		picks.name = validName(body.name);
	}
	if (body.face !== undefined) picks.face = validFace(body.face);
	if (body.personality !== undefined) {
		if (typeof body.personality !== "string") throw new BadRequest("personality is how it speaks, as text");
		const words = personalityWords(body.personality);
		if (typeof words !== "string") throw new BadRequest(words.refused);
		picks.personality = words;
	}

	return picks;
}

/** Replace just the face scalar in the accepted file, preserving all other fields and its body. */
function withFace(text: string, face: AvatarFace): string {
	const match = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
	if (match === null) throw new Error("the lead's accepted file has no frontmatter");
	const head = match[2] ?? "";
	const line = `face: ${writeAvatarFace(face)}`;
	const updated = /^face:[^\r\n]*/m.test(head) ? head.replace(/^face:[^\r\n]*/m, () => line) : `${head}\n${line}`;
	return `${match[1]}${updated}${match[3]}${text.slice(match[0].length)}`;
}

/**
 * Change the companion as the owner picked. Face and personality are written into the lead's accepted agent file,
 * before the rest is stored: a box that cannot take it stores nothing. New
 * chats start with what is stored; existing chats receive it at their next safe model boundary.
 */
export async function change(
	harness: Harness,
	workspace: Workspace,
	picks: CompanionPicks,
	changed: AgentChanged,
	ctx: Context = context,
): Promise<void> {
	if (picks.personality !== undefined || picks.face !== undefined) {
		const lead = (await harness.snapshot(Accepted, ctx))?.files[agentPath(LEAD)];
		if (lead === undefined) throw new Error("the lead has no accepted file");
		if (picks.base !== undefined && picks.base !== lead.sha)
			throw new BadRequest("your companion changed since you saw it: look again", 409);
		let text = lead.text;
		if (picks.personality !== undefined && personalityOf(text) !== picks.personality)
			text = withPersonality(text, picks.personality);
		if (picks.face !== undefined) {
			const parsed = parseAgent(LEAD, text);
			if (!("agent" in parsed) || writeAvatarFace(parsed.agent.face) !== writeAvatarFace(picks.face))
				text = withFace(text, picks.face);
		}
		if (text !== lead.text) {
			try {
				await save(harness, workspace, LEAD, text, picks.base ?? lead.sha, changed, ctx);
			} catch (error) {
				if (error instanceof BadRequest && error.status === 409)
					throw new BadRequest(
						"your companion's own file has a change waiting for you: allow it or not, then pick again",
						409,
					);
				throw error;
			}
		}
	}
	const { name, tier } = picks;
	if (name !== undefined || tier !== undefined)
		await setCompanion(
			harness,
			{ ...(name === undefined ? {} : { name }), ...(tier === undefined ? {} : { tier }) },
			ctx,
		);
}
