/**
 * What an agent made or changed in the band, in its chat (DESIGN.md "Agents"): one row that says it and links to it,
 * which opens into a card of what is in effect. The daemon applied it in the agent's call, so there is nothing to
 * answer here: the card informs, and says what the call could not touch. Drawn from the daemon's receipt alone.
 */
import { FilePenIcon, UserRoundPlusIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { BandReceipt } from "../../../src/core/band-tools.ts";
import { Done } from "./Done.tsx";
import { AvatarPreview, FieldChange } from "./Proposal.tsx";

type AgentReceipt = Extract<BandReceipt, { kind: "agent" }>;

const FIELD: { readonly [field: string]: string } = {
	name: "name",
	face: "face",
	description: "description",
	instructions: "instructions",
	model: "model",
	tier: "tier",
};

const modelWords = (agent: { readonly model?: { provider: string; modelId: string } | null | undefined }) =>
	agent.model == null ? "Default model" : `${agent.model.provider}/${agent.model.modelId}`;
const tierWords = (agent: { readonly tier?: string | null | undefined }) =>
	agent.tier == null ? "Default tier" : `${agent.tier[0]?.toUpperCase()}${agent.tier.slice(1)}`;

/** The fields a change changed, as words: "description and instructions". */
export function changedWords(receipt: Extract<AgentReceipt, { change: "updated" }>): string {
	const fields = Object.keys(receipt.before).map((field) => FIELD[field] ?? field);
	return fields.length <= 1 ? (fields[0] ?? "") : `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
}

function Instructions({ label, children }: { label: string; children: string }) {
	return (
		<div>
			<p className="text-meta font-medium">{label}</p>
			<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-field bg-paper px-3 py-2 font-sans text-ui">
				{children}
			</pre>
		</div>
	);
}

function Frame({
	icon,
	title,
	label,
	children,
	link,
}: {
	icon: ReactNode;
	title: string;
	label: string;
	children: ReactNode;
	link: { readonly href: string; readonly words: string };
}) {
	return (
		<section
			className="mx-auto w-full max-w-[36rem] rounded-tile border border-line bg-paper-2 px-4 py-3"
			aria-label={label}
			data-band-change=""
		>
			<div className="flex items-center gap-2 text-ui font-semibold text-ink">
				{icon}
				<span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
			</div>
			<div className="mt-2 space-y-2 text-ui text-ink-2">{children}</div>
			<p className="mt-3 flex justify-end">
				<a
					href={link.href}
					className="rounded-field px-3 py-1.5 text-ui font-medium text-ink no-underline hover:bg-paper-3"
				>
					{link.words}
				</a>
			</p>
		</section>
	);
}

/** The card of a row, opened: the agent or group as the call left it. Read only. */
export function BandChangeCard({ receipt }: { receipt: BandReceipt }) {
	if (receipt.kind === "group")
		return (
			<Frame
				icon={<UsersIcon aria-hidden="true" className="size-4 shrink-0" />}
				title={`New group: ${receipt.name}`}
				label="New group"
				link={{ href: `#/g/${receipt.room}`, words: "Open the group" }}
			>
				<p>Members: {receipt.members.map(({ name }) => name).join(", ")}</p>
				<p>Each keeps its own tools, memory and permissions.</p>
			</Frame>
		);
	const { agent } = receipt;
	if (receipt.change === "created")
		return (
			<Frame
				icon={<UserRoundPlusIcon aria-hidden="true" className="size-4 shrink-0" />}
				title={`New agent: ${agent.name}`}
				label="New agent"
				link={{ href: `#/a/${receipt.id}`, words: `Open ${agent.name}` }}
			>
				<div className="flex items-center gap-3">
					<AvatarPreview face={agent.face} label={agent.name} />
					<p className="min-w-0 [overflow-wrap:anywhere]">{agent.description}</p>
				</div>
				<p>
					{modelWords(agent)} · {tierWords(agent)}
				</p>
				<details>
					<summary className="cursor-pointer text-meta">Instructions</summary>
					<div className="mt-2">
						<Instructions label="In effect">{agent.instructions}</Instructions>
					</div>
				</details>
				<p>It has no connections or permissions yet. Those are yours to give.</p>
			</Frame>
		);
	const { before } = receipt;
	return (
		<Frame
			icon={<FilePenIcon aria-hidden="true" className="size-4 shrink-0" />}
			title={`Updated ${agent.name}`}
			label="Updated agent"
			link={{ href: `#/a/${receipt.id}`, words: `Open ${agent.name}` }}
		>
			{before.name == null ? null : <FieldChange label="Name" before={before.name} after={agent.name} />}
			{before.face == null ? null : (
				<div>
					<p className="text-meta font-medium text-ink-2">Face</p>
					<div className="mt-1 flex items-center gap-2">
						<AvatarPreview face={before.face} label={`Earlier face of ${agent.name}`} />
						<span aria-hidden="true">→</span>
						<AvatarPreview face={agent.face} label={`Face of ${agent.name} now`} />
					</div>
				</div>
			)}
			{before.description == null ? null : (
				<FieldChange label="Description" before={before.description} after={agent.description} />
			)}
			{"model" in before ? <FieldChange label="Model" before={modelWords(before)} after={modelWords(agent)} /> : null}
			{"tier" in before ? <FieldChange label="Tier" before={tierWords(before)} after={tierWords(agent)} /> : null}
			{before.instructions == null ? null : (
				<details>
					<summary className="cursor-pointer text-meta">Instructions</summary>
					<div className="mt-2 space-y-2">
						<Instructions label="Before">{before.instructions}</Instructions>
						<Instructions label="In effect">{agent.instructions}</Instructions>
					</div>
				</details>
			)}
			<p>Its tools, connections and permissions didn’t change.</p>
		</Frame>
	);
}

/** The row: what was done and a link to it; it opens into the card. */
export function BandChangeRow({
	receipt,
	time,
	open,
}: {
	receipt: BandReceipt;
	time?: string | undefined;
	open?: boolean;
}) {
	const card = <BandChangeCard receipt={receipt} />;
	if (receipt.kind === "group")
		return (
			<Done
				kind="group"
				action="created the group"
				reference={{
					node: (
						<a href={`#/g/${receipt.room}`} className="min-w-0 truncate text-ink no-underline hover:underline">
							{receipt.name}
						</a>
					),
				}}
				note={receipt.members.map(({ name }) => name).join(", ")}
				time={time}
				card={card}
				open={open}
			/>
		);
	const who = { id: receipt.id, name: receipt.agent.name, face: receipt.agent.face };
	return receipt.change === "created" ? (
		<Done
			kind="agent"
			action="created"
			reference={{ agent: who, title: receipt.agent.description }}
			time={time}
			card={card}
			open={open}
		/>
	) : (
		<Done
			kind="change"
			action="updated"
			reference={{ agent: who, title: changedWords(receipt) }}
			time={time}
			card={card}
			open={open}
		/>
	);
}
