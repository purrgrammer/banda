import type { AvatarDefinition } from "open-bot-avatar";
import { saveEdit } from "../app/edits.ts";
import { showAgents, useShell } from "../lib/shell.ts";
import { AvatarCandidateCard } from "./CandidateCard.tsx";

/** The chat supplies the target, never model arguments. Applying reuses the owner's existing face-edit path. */
export function AvatarCandidateMessage({ agent, definition }: { agent: string; definition: AvatarDefinition }) {
	const shell = useShell();
	const accepted = shell.agents.find((file) => file.name === agent)?.accepted?.agent;
	// Colour and the save's revision must come from the same accepted file, not separate SSE projections.
	const current = accepted;
	if (!current || current.state === "archived") return null;
	return (
		<AvatarCandidateCard
			definition={definition}
			current={current.face}
			name={(agent === "sancho" ? shell.companion?.name : current.name) ?? "Your agent"}
			onUse={(face) => saveEdit(agent, { face }, shell.agents, shell.companion, showAgents)}
		/>
	);
}
