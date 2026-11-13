import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { personalityWords, withPersonality } from "../../../src/core/choices.ts";
import { type AgentFileView, type AgentView, api, changeCompanion, Refused, saveAgent } from "../lib/api.ts";
import { failureWords } from "../lib/attempt.ts";
import { edited } from "./edit-file.ts";
import { type PersonalityDrafts, personalityDrafts } from "./personality-drafts.ts";

export type { PersonalityDrafts } from "./personality-drafts.ts";

export function personalityFile(agent: string, file: AgentFileView, text: string) {
	if (agent !== "sancho") return edited(file.text, { personality: text });
	const words = personalityWords(text);
	return withPersonality(file.text, typeof words === "string" ? words : text);
}

export function createPersonalityDrafts(): PersonalityDrafts {
	return personalityDrafts(
		async (agent, base, text) => {
			const next = personalityFile(agent, base, text);
			let agents: readonly AgentView[];
			if (agent === "sancho") {
				const picks = { personality: text, base: base.sha };
				await changeCompanion(picks);
				agents = await api<AgentView[]>("/agents");
			} else agents = await saveAgent(agent, next, base.sha);
			const file = agents.find((row) => row.name === agent)?.accepted;
			if (file === undefined || file.text !== next)
				throw new Refused("The agent changed while this edit was being saved. Your changes are kept here.", 409);
			return { file, agents };
		},
		failureWords,
		personalityFile,
	);
}

export function AgentPersonality({
	agent,
	file,
	text,
	drafts,
	onSaved,
}: {
	agent: string;
	file: AgentFileView;
	text: string;
	drafts: PersonalityDrafts;
	onSaved: (agents: readonly AgentView[]) => void;
}) {
	const [draft] = useState(() => drafts.forAgent(agent, file, text, onSaved));
	const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
	const id = useId();
	const help = `${id}-help`;
	const error = `${id}-error`;
	useEffect(() => {
		draft.receive(file, text);
	}, [draft, file, text]);
	const failed = state.status.kind === "failed";
	const changed = state.base.file.sha !== state.latest.file.sha;
	return (
		<FieldGroup>
			<Field data-invalid={failed || undefined}>
				<FieldLabel htmlFor={id}>Personality</FieldLabel>
				<FieldDescription id={help}>How it talks and what it cares about, in your words.</FieldDescription>
				<Textarea
					id={id}
					name="personality"
					value={state.text}
					onChange={(event) => draft.edit(event.target.value)}
					aria-invalid={failed || undefined}
					aria-describedby={failed ? `${help} ${error}` : help}
					className="min-h-32"
				/>
				{state.status.kind === "failed" ? (
					<Alert id={error}>
						<AlertTitle>Your changes are kept</AlertTitle>
						<AlertDescription>
							<p>{state.status.message}</p>
							{changed ? (
								<>
									<details>
										<summary>Review the saved version</summary>
										<p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{state.latest.text}</p>
									</details>
									<Button type="button" variant="outline" onClick={() => draft.chooseMine(state.latest.file.sha)}>
										Use my changes
									</Button>
								</>
							) : (
								<Button type="button" variant="outline" onClick={() => draft.retry()}>
									Try again
								</Button>
							)}
						</AlertDescription>
					</Alert>
				) : (
					<p role="status" className="text-meta text-ink-2">
						{state.status.kind === "saving" ? "Saving…" : state.status.kind === "pending" ? "Not saved yet" : "Saved"}
					</p>
				)}
			</Field>
		</FieldGroup>
	);
}
