import { FilePenIcon, UsersIcon } from "lucide-react";
import { renderAvatarSvg } from "open-bot-avatar";
import { type ReactNode, useEffect, useState } from "react";
import type { Agent } from "../../../src/core/agents.ts";
import type { ProposalEdits, ProposalText } from "../../../src/core/proposals.ts";
import type { AgentDefinitionPreview, ProposalView } from "../../../src/server/proposals.ts";
import { EDITED_WORDS, EditableText } from "./EditableText.tsx";

function AvatarPreview({ face, label }: { face: Agent["face"]; label: string }) {
	return (
		<img
			className="size-7 shrink-0"
			src={`data:image/svg+xml,${encodeURIComponent(
				renderAvatarSvg(face.definition, { color: face.color, size: 28, reducedMotion: true }),
			)}`}
			alt={label}
		/>
	);
}

function FieldChange({ label, before, after }: { label: string; before: string; after: string }) {
	return (
		<div>
			<p className="text-meta font-medium text-ink-2">{label}</p>
			<p className="[overflow-wrap:anywhere]">
				<span className="text-ink-3 line-through">{before}</span>
				<span aria-hidden="true"> → </span>
				<span className="text-ink">{after}</span>
			</p>
		</div>
	);
}

function AgentChangePreview({
	before: old,
	after: next,
	fields,
}: {
	before: AgentDefinitionPreview;
	after: AgentDefinitionPreview;
	/** The proposed text, drawn editable where the change proposes it: in place of its "after". */
	fields: { readonly [field in ProposalText]?: ReactNode };
}) {
	const sameFace = JSON.stringify(old.face) === JSON.stringify(next.face);
	const oldModel = old.model === undefined ? "Default model" : `${old.model.provider}/${old.model.modelId}`;
	const newModel = next.model === undefined ? "Default model" : `${next.model.provider}/${next.model.modelId}`;
	const oldTier = old.tier === undefined ? "Default tier" : `${old.tier[0]?.toUpperCase()}${old.tier.slice(1)}`;
	const newTier = next.tier === undefined ? "Default tier" : `${next.tier[0]?.toUpperCase()}${next.tier.slice(1)}`;
	const modelChanged = oldModel !== newModel;
	const tierChanged = oldTier !== newTier;
	const instructionsChanged = old.instructions !== next.instructions || fields.instructions !== undefined;
	const hasDetails = modelChanged || tierChanged || instructionsChanged;

	return (
		<div className="space-y-2">
			{old.name === next.name ? null : <FieldChange label="Name" before={old.name} after={next.name} />}
			{sameFace ? null : (
				<div>
					<p className="text-meta font-medium text-ink-2">Face</p>
					<div className="mt-1 flex items-center gap-2">
						<AvatarPreview face={old.face} label={`Current face for ${old.name}`} />
						<span aria-hidden="true">→</span>
						<AvatarPreview face={next.face} label={`Proposed face for ${next.name}`} />
					</div>
				</div>
			)}
			{fields.description !== undefined ? (
				<div className="space-y-1">
					<p className="text-meta text-ink-3 [overflow-wrap:anywhere]">Now: {old.description}</p>
					{fields.description}
				</div>
			) : old.description === next.description ? null : (
				<FieldChange label="Description" before={old.description} after={next.description} />
			)}
			{hasDetails ? (
				<details>
					<summary className="cursor-pointer text-meta">Agent details</summary>
					<div className="mt-2 space-y-2">
						{modelChanged ? <FieldChange label="Model" before={oldModel} after={newModel} /> : null}
						{tierChanged ? <FieldChange label="Tier" before={oldTier} after={newTier} /> : null}
						{instructionsChanged ? (
							<details>
								<summary className="cursor-pointer text-meta">Instructions</summary>
								<div className="mt-2 space-y-2">
									<div>
										<p className="text-meta font-medium">Current</p>
										<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-field bg-paper px-3 py-2 font-sans text-ui">
											{old.instructions}
										</pre>
									</div>
									{fields.instructions ?? (
										<div>
											<p className="text-meta font-medium">Proposed</p>
											<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-field bg-paper px-3 py-2 font-sans text-ui">
												{next.instructions}
											</pre>
										</div>
									)}
								</div>
							</details>
						) : null}
					</div>
				</details>
			) : null}
		</div>
	);
}

/** The proposed text of `proposal` the owner may edit: an agent's description and instructions, where it proposes them. */
function proposedText(proposal: ProposalView): { [field in ProposalText]?: string } {
	if (proposal.kind === "group") return {};
	return {
		...(proposal.description === undefined ? {} : { description: proposal.description }),
		...(proposal.instructions === undefined ? {} : { instructions: proposal.instructions }),
	};
}

/**
 * An agent's proposed creation or edit, reviewed in its chat and inert until the owner accepts it. Its description and
 * instructions are the agent's words for the owner and itself: the owner may edit them before accepting, and what is
 * accepted is their text (`edited`, once decided).
 */
export function ProposalCard({
	proposal,
	state,
	edited,
	onAct,
}: {
	proposal: ProposalView;
	state: ProposalView["state"];
	/** The text the owner edited before accepting it, as accepted. */
	edited?: ProposalEdits | undefined;
	onAct?: (action: "accept" | "decline", edits?: ProposalEdits) => Promise<"accepted" | "declined">;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [reviewState, setReviewState] = useState(state);
	const proposed = proposedText(proposal);
	const [text, setText] = useState<{ [field in ProposalText]?: string }>({});
	useEffect(() => {
		setReviewState(state);
	}, [state]);
	const pending = reviewState === "pending";
	/** The text as it stands: the owner's edit while pending, what was accepted after. */
	const shown = (field: ProposalText) =>
		(pending ? text[field] : reviewState === "accepted" ? (edited?.[field] ?? text[field]) : undefined) ??
		proposed[field] ??
		"";
	const changes = Object.fromEntries(
		(Object.keys(proposed) as ProposalText[]).flatMap((field) =>
			text[field] !== undefined && text[field] !== proposed[field] ? [[field, text[field]]] : [],
		),
	) as ProposalEdits;
	const invalid = {
		description:
			shown("description").trim() === "" || /[\r\n]/.test(shown("description"))
				? "One line, not empty."
				: shown("description").length > 240
					? "At most 240 characters."
					: undefined,
		instructions: shown("instructions").trim() === "" ? "Some instructions, not empty." : undefined,
	};
	const blocked = pending && (Object.keys(changes) as ProposalText[]).some((field) => invalid[field] !== undefined);
	const field = (name: ProposalText, label: string) =>
		proposed[name] === undefined ? undefined : (
			<EditableText
				label={label}
				value={shown(name)}
				original={proposed[name] ?? ""}
				line={name === "description"}
				disabled={busy}
				invalid={pending && changes[name] !== undefined ? invalid[name] : undefined}
				onChange={
					pending && onAct !== undefined ? (next) => setText((prior) => ({ ...prior, [name]: next })) : undefined
				}
			/>
		);
	const editedAny = (Object.keys(proposed) as ProposalText[]).some((name) => shown(name) !== proposed[name]);
	const title =
		proposal.kind === "agent"
			? `Create ${proposal.name}`
			: proposal.kind === "group"
				? `Create ${proposal.name}`
				: `Update ${proposal.displayName}`;
	const act = async (action: "accept" | "decline") => {
		if (onAct === undefined) return;
		setBusy(true);
		setError(undefined);
		try {
			setReviewState(await onAct(action, action === "accept" && Object.keys(changes).length > 0 ? changes : undefined));
		} catch (failed) {
			setError(failed instanceof Error ? failed.message : String(failed));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section
			className="mx-auto w-full max-w-[36rem] rounded-tile border border-line bg-paper-2 px-4 py-3"
			aria-label="Agent proposal"
		>
			<div className="flex items-center gap-2 text-ui font-semibold text-ink">
				{proposal.kind === "group" ? <UsersIcon className="size-4" /> : <FilePenIcon className="size-4" />}
				{title}
			</div>
			<div className="mt-2 space-y-2 text-ui text-ink-2">
				{proposal.kind === "agent" ? (
					<>
						<div className="flex items-center gap-3">
							<AvatarPreview face={proposal.face} label={proposal.name} />
							<p className="min-w-0 font-medium text-ink">{proposal.name}</p>
						</div>
						{field("description", "Description")}
						<details>
							<summary className="cursor-pointer text-meta">
								Agent details
								{shown("instructions") === proposed.instructions ? null : ` · ${EDITED_WORDS}`}
							</summary>
							<div className="mt-2 space-y-2">
								<p>
									{proposal.model === undefined
										? "Default model"
										: `Model: ${proposal.model.provider}/${proposal.model.modelId}`}
									{proposal.tier === undefined
										? ""
										: ` · ${proposal.tier[0]?.toUpperCase()}${proposal.tier.slice(1)} tier`}
								</p>
								{field("instructions", "Instructions")}
							</div>
						</details>
						<p>Tools and connections remain owner-controlled.</p>
					</>
				) : proposal.kind === "group" ? (
					<p>Members: {proposal.memberNames.join(", ")}</p>
				) : (
					<>
						<AgentChangePreview
							before={proposal.beforeAgent}
							after={proposal.proposedAgent}
							fields={{
								...(proposed.description === undefined ? {} : { description: field("description", "Description") }),
								...(proposed.instructions === undefined
									? {}
									: { instructions: field("instructions", "Proposed instructions") }),
							}}
						/>
						<p>Tools, connections and state won’t change.</p>
					</>
				)}
			</div>
			{reviewState === "pending" ? (
				<div className="mt-3 flex flex-wrap justify-end gap-2">
					<button
						type="button"
						disabled={busy || onAct === undefined}
						onClick={() => void act("decline")}
						className="rounded-field px-3 py-1.5 text-ui text-ink-2 hover:bg-paper-3"
					>
						{proposal.kind === "agentChange" ? "Keep current" : "Cancel"}
					</button>
					<button
						type="button"
						disabled={busy || onAct === undefined || blocked}
						onClick={() => void act("accept")}
						className="rounded-field bg-ink px-3 py-1.5 text-ui font-medium text-paper hover:bg-ink/85"
					>
						{busy
							? "Saving…"
							: proposal.kind === "group"
								? "Create group"
								: proposal.kind === "agent"
									? "Create agent"
									: "Update agent"}
					</button>
				</div>
			) : (
				<p className="mt-3 text-meta text-ink-2">
					{reviewState === "accepted"
						? editedAny
							? `Accepted · ${EDITED_WORDS}`
							: "Accepted"
						: proposal.kind === "agentChange"
							? "Kept as is"
							: "Cancelled"}
				</p>
			)}
			{error === undefined ? null : (
				<p role="alert" className="mt-2 text-meta text-danger">
					{error}
				</p>
			)}
		</section>
	);
}
