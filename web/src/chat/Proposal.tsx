import { FilePenIcon, UsersIcon } from "lucide-react";
import { renderAvatarSvg } from "open-bot-avatar";
import { useEffect, useState } from "react";
import type { Agent } from "../../../src/core/agents.ts";
import type { AgentDefinitionPreview, ProposalView } from "../../../src/server/proposals.ts";

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
}: {
	before: AgentDefinitionPreview;
	after: AgentDefinitionPreview;
}) {
	const sameFace = JSON.stringify(old.face) === JSON.stringify(next.face);
	const oldModel = old.model === undefined ? "Default model" : `${old.model.provider}/${old.model.modelId}`;
	const newModel = next.model === undefined ? "Default model" : `${next.model.provider}/${next.model.modelId}`;
	const oldTier = old.tier === undefined ? "Default tier" : `${old.tier[0]?.toUpperCase()}${old.tier.slice(1)}`;
	const newTier = next.tier === undefined ? "Default tier" : `${next.tier[0]?.toUpperCase()}${next.tier.slice(1)}`;
	const modelChanged = oldModel !== newModel;
	const tierChanged = oldTier !== newTier;
	const instructionsChanged = old.instructions !== next.instructions;
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
			{old.description === next.description ? null : (
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
									<div>
										<p className="text-meta font-medium">Proposed</p>
										<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-field bg-paper px-3 py-2 font-sans text-ui">
											{next.instructions}
										</pre>
									</div>
								</div>
							</details>
						) : null}
					</div>
				</details>
			) : null}
		</div>
	);
}

/** An agent's proposed creation or edit, reviewed in its chat and inert until the owner accepts it. */
export function ProposalCard({
	proposal,
	state,
	onAct,
}: {
	proposal: ProposalView;
	state: ProposalView["state"];
	onAct?: (action: "accept" | "decline") => Promise<"accepted" | "declined">;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [reviewState, setReviewState] = useState(state);
	useEffect(() => {
		setReviewState(state);
	}, [state]);
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
			setReviewState(await onAct(action));
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
							<div className="min-w-0">
								<p className="font-medium text-ink">{proposal.name}</p>
								<p>{proposal.description}</p>
							</div>
						</div>
						<details>
							<summary className="cursor-pointer text-meta">Agent details</summary>
							<div className="mt-2 space-y-2">
								<p>
									{proposal.model === undefined
										? "Default model"
										: `Model: ${proposal.model.provider}/${proposal.model.modelId}`}
									{proposal.tier === undefined
										? ""
										: ` · ${proposal.tier[0]?.toUpperCase()}${proposal.tier.slice(1)} tier`}
								</p>
								<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-field bg-paper px-3 py-2 font-sans text-ui">
									{proposal.instructions}
								</pre>
							</div>
						</details>
						<p>Tools and connections remain owner-controlled.</p>
					</>
				) : proposal.kind === "group" ? (
					<p>Members: {proposal.memberNames.join(", ")}</p>
				) : (
					<>
						<AgentChangePreview before={proposal.beforeAgent} after={proposal.proposedAgent} />
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
						disabled={busy || onAct === undefined}
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
					{reviewState === "accepted" ? "Accepted" : proposal.kind === "agentChange" ? "Kept as is" : "Cancelled"}
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
