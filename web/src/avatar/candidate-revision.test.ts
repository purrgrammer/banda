import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { LEAD_TEXT, shaOf } from "../../../src/core/agents.ts";
import { type AvatarFace, defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { edited } from "../app/edit-file.ts";
import { changeCompanion } from "../lib/api.ts";
import { AvatarCandidateMessage } from "./CandidateMessage.tsx";

const mocks = vi.hoisted(() => ({
	shell: { agents: [] as unknown[], companion: undefined as unknown },
	card: vi.fn<(props: { current: AvatarFace; onUse: (face: AvatarFace) => Promise<void> }) => null>(() => null),
}));
vi.mock("../lib/shell.ts", () => ({ useShell: () => mocks.shell, showAgents: vi.fn() }));
vi.mock("../lib/api.ts", () => ({ changeCompanion: vi.fn(), saveAgent: vi.fn() }));
vi.mock("./CandidateCard.tsx", () => ({ AvatarCandidateCard: mocks.card }));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.shell.agents = [];
	mocks.shell.companion = undefined;
});

it("takes the first agent's preview colour and submitted revision from the same accepted projection", async () => {
	const current = { ...defaultAvatarFace(), color: "#112233" };
	const text = edited(LEAD_TEXT, { face: current });
	const sha = shaOf(text);
	mocks.shell.agents = [{ name: "sancho", accepted: { text, sha, agent: { face: current, state: "active" } } }];
	// A separately refreshed companion projection can still carry the old colour.
	mocks.shell.companion = { name: "Sancho", face: defaultAvatarFace() };
	const definition = { ...current.definition, name: "Candidate" };
	renderToStaticMarkup(createElement(AvatarCandidateMessage, { agent: "sancho", definition }));
	const card = mocks.card.mock.calls[0]?.[0];
	if (card === undefined) throw new Error("no candidate card");
	expect(card.current).toEqual(current);
	const face = { definition, color: card.current.color };
	await card.onUse(face);
	expect(changeCompanion).toHaveBeenCalledExactlyOnceWith({ face, base: sha });
});

it("cannot offer an unversioned first-agent candidate while the accepted file is still loading", () => {
	mocks.shell.companion = { name: "Sancho", face: defaultAvatarFace() };
	renderToStaticMarkup(
		createElement(AvatarCandidateMessage, { agent: "sancho", definition: defaultAvatarFace().definition }),
	);
	expect(mocks.card).not.toHaveBeenCalled();
});
