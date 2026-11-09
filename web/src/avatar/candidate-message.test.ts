import { getExample } from "open-bot-avatar";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AvatarFace, defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { AvatarCandidateMessage } from "./CandidateMessage.tsx";

const mocked = vi.hoisted(() => ({
	shell: {} as Record<string, unknown>,
	save: vi.fn(async () => {}),
	show: vi.fn(),
	card: undefined as { current: AvatarFace; name: string; onUse: (face: AvatarFace) => Promise<void> } | undefined,
}));
vi.mock("../lib/shell.ts", () => ({ useShell: () => mocked.shell, showAgents: mocked.show }));
vi.mock("../app/edits.ts", () => ({ saveEdit: mocked.save }));
vi.mock("./CandidateCard.tsx", () => ({
	AvatarCandidateCard: (props: NonNullable<typeof mocked.card>) => {
		mocked.card = props;
		return createElement("p", {}, "Preview");
	},
}));

beforeEach(() => {
	mocked.card = undefined;
	mocked.save.mockClear();
});

describe("the chat's face candidate action", () => {
	it.each(["sancho", "mira"])(
		"targets only %s, as supplied by the chat, through the existing owner edit",
		async (agent) => {
			const current = { ...defaultAvatarFace(), color: "#123456" };
			const definition = getExample("mug");
			if (!definition) throw new Error("missing mug fixture");
			const identity = { id: agent, name: "Mira", face: current, state: "active" };
			mocked.shell = { agents: [{ name: agent, accepted: { agent: identity } }], companion: identity };
			expect(renderToStaticMarkup(createElement(AvatarCandidateMessage, { agent, definition }))).toContain("Preview");
			expect(mocked.card?.current).toEqual(current);
			expect(mocked.save).not.toHaveBeenCalled();
			const chosen = { definition, color: current.color };
			await mocked.card?.onUse(chosen);
			expect(mocked.save).toHaveBeenCalledExactlyOnceWith(
				agent,
				{ face: chosen },
				mocked.shell.agents,
				mocked.shell.companion,
				mocked.show,
			);
		},
	);

	it("does not offer an apply action for an absent or archived agent", () => {
		const definition = defaultAvatarFace().definition;
		for (const state of [{ agents: [] }, { agents: [{ name: "mira", accepted: { agent: { state: "archived" } } }] }]) {
			mocked.shell = state;
			expect(renderToStaticMarkup(createElement(AvatarCandidateMessage, { agent: "mira", definition }))).toBe("");
			expect(mocked.card).toBeUndefined();
		}
		expect(mocked.save).not.toHaveBeenCalled();
	});
});
