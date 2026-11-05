import { useState } from "react";
import type { FactView } from "../../../src/server/api.ts";
import { MemorySettings } from "../chat/MemorySettings.tsx";
import { Section } from "./stage.tsx";

function Example() {
	const [facts, setFacts] = useState<FactView[]>([
		{ id: "mshared", text: "Use metric units.", scope: "global" },
		{ id: "mmara", text: "For travel plans, compare direct trains first.", scope: "agent", agent: "mara" },
		{ id: "matlas", text: "Research briefs start with primary sources.", scope: "agent", agent: "atlas" },
	]);
	return (
		<div className="grid w-full gap-8 md:grid-cols-2">
			<MemorySettings
				agent={{ id: "mara", name: "Mara" }}
				memory={{ facts }}
				onAdd={async (text, scope) =>
					setFacts((was) => [
						...was,
						{ id: crypto.randomUUID(), text, ...(scope === "agent" ? { scope, agent: "mara" } : { scope }) },
					])
				}
				onEdit={async (id, text) => setFacts((was) => was.map((fact) => (fact.id === id ? { ...fact, text } : fact)))}
				onForget={async (id) => setFacts((was) => was.filter((fact) => fact.id !== id))}
			/>
			<MemorySettings
				memory={{ facts }}
				onAdd={async (text) => setFacts((was) => [...was, { id: crypto.randomUUID(), text, scope: "global" }])}
				onEdit={async (id, text) => setFacts((was) => was.map((fact) => (fact.id === id ? { ...fact, text } : fact)))}
				onForget={async (id) => setFacts((was) => was.filter((fact) => fact.id !== id))}
			/>
		</div>
	);
}

export function MemorySection() {
	const inactive = { onAdd: async () => {}, onEdit: async () => {}, onForget: async () => {} };
	return (
		<Section
			id="scoped-memory"
			title="Memory: this agent and the band"
			note="Interactive: the agent's controls and Settings share one set of global facts. Atlas's facts never appear in Mara's view. Forgetting a fact does not erase chat history."
		>
			<Example />
			<div className="grid w-full gap-8 md:grid-cols-2">
				<MemorySettings memory={undefined} {...inactive} />
				<MemorySettings memory={{ facts: [], unavailable: true }} {...inactive} />
			</div>
		</Section>
	);
}
