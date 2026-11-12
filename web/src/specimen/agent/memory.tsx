import { useState } from "react";
import { defaultAvatarFace } from "../../../../src/core/avatar-face.ts";
import type { FactView } from "../../../../src/server/api.ts";
import { type MemoryAgent, MemorySettings, type NewFactSpec } from "../../chat/MemorySettings.tsx";
import { Section } from "../stage.tsx";

const face = defaultAvatarFace();
const AGENTS: readonly MemoryAgent[] = [
	{ id: "mara", name: "Mara", face },
	{ id: "atlas", name: "Atlas", face },
	{ id: "rook", name: "Rook", face, archived: true },
];

function Example({ phone = false }: { phone?: boolean }) {
	const [facts, setFacts] = useState<FactView[]>([
		{ id: "mshared", text: "Use metric units.", scope: "global", size: 32, from: { owner: true } },
		{
			id: "mmara",
			text: "For travel plans, compare direct trains first.",
			scope: "agent",
			agent: "mara",
			size: 66,
			from: { chat: 3 },
		},
		{
			id: "msarah",
			text: "Sarah is vegetarian.",
			scope: "agent",
			agent: "mara",
			about: "Sarah",
			for: "dinner on Friday",
			size: 72,
			from: { owner: true },
		},
		{ id: "matlas", text: "Research briefs start with primary sources.", scope: "agent", agent: "atlas", size: 60 },
		{ id: "mrook", text: "Weekly digests go out on Mondays.", scope: "agent", agent: "rook", size: 50 },
	]);
	const originOf = (fact: FactView) => (fact.from === undefined || "owner" in fact.from ? undefined : "Saved by Mara");
	const actions = {
		onAdd: async (fact: NewFactSpec) =>
			setFacts((was) => [
				...was,
				{
					id: crypto.randomUUID(),
					text: fact.text,
					size: fact.text.length + 15,
					from: { owner: true as const },
					...(fact.about === undefined ? {} : { about: fact.about }),
					...(fact.task === undefined ? {} : { for: fact.task }),
					...(fact.scope === "agent" ? { scope: fact.scope, agent: fact.agent ?? "mara" } : { scope: fact.scope }),
				},
			]),
		onEdit: async (id: string, text: string) =>
			setFacts((was) => was.map((fact) => (fact.id === id ? { ...fact, text } : fact))),
		onForget: async (id: string) => setFacts((was) => was.filter((fact) => fact.id !== id)),
	};
	return (
		<div className="grid w-full gap-8 md:grid-cols-2">
			<MemorySettings
				agent={{ id: "mara", name: "Mara" }}
				phone={phone}
				memory={{ facts, budget: 4000 }}
				originOf={originOf}
				{...actions}
			/>
			<MemorySettings agents={AGENTS} phone={phone} memory={{ facts, budget: 4000 }} originOf={originOf} {...actions} />
		</div>
	);
}

export function MemorySection() {
	const inactive = { onAdd: async () => {}, onEdit: async () => {}, onForget: async () => {}, onRetry: async () => {} };
	return (
		<Section id="scoped-memory" note="Mara's Memory tab beside Settings' Memory: the same facts, never a copy.">
			<Example />
			<div className="grid w-full max-w-[52rem] gap-8 md:grid-cols-2">
				<Example phone />
			</div>
			<div className="grid w-full gap-8 md:grid-cols-2">
				<MemorySettings memory={undefined} {...inactive} />
				<MemorySettings memory={{ facts: [], unavailable: true }} {...inactive} />
			</div>
		</Section>
	);
}
