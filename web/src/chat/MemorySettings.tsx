/** One view of the same facts in agent controls and Settings; no second copy of shared memory. */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MemoryScope, MemoryView } from "../../../src/server/api.ts";
import { Memory } from "./Settings.tsx";

export type MemoryActions = {
	onAdd: (text: string, scope: MemoryScope) => Promise<void>;
	onEdit: (id: string, text: string) => Promise<void>;
	onForget: (id: string) => Promise<void>;
};

export function MemorySettings({
	agent,
	memory,
	...actions
}: {
	agent?: { id: string; name: string };
	memory: MemoryView | undefined;
} & MemoryActions) {
	const available = memory !== undefined && !memory.unavailable;
	const section = (scope: MemoryScope) => (
		<Memory
			agent={agent?.name ?? "The band"}
			shared={scope === "global"}
			facts={(memory?.facts ?? []).filter((fact) =>
				scope === "global" ? fact.scope === "global" : fact.scope === "agent" && fact.agent === agent?.id,
			)}
			onAdd={(text) => actions.onAdd(text, scope)}
			onEdit={actions.onEdit}
			onForget={actions.onForget}
		/>
	);
	return (
		<>
			{available ? null : (
				<p role={memory === undefined ? "status" : "alert"} className="text-ui text-ink-2">
					{memory === undefined
						? "Reading memory…"
						: "Can't read memory right now. Your draft is kept; try again when memory is available."}
				</p>
			)}
			{/* Keep editors mounted through read failures: availability is not the lifetime of an owner's draft. */}
			<fieldset hidden={!available} disabled={!available} className="min-w-0">
				{agent === undefined ? (
					section("global")
				) : (
					<Tabs defaultValue="agent" className="gap-4">
						<TabsList aria-label="Memory scope">
							<TabsTrigger value="agent">This agent</TabsTrigger>
							<TabsTrigger value="global">Shared with the band</TabsTrigger>
						</TabsList>
						<TabsContent value="agent" forceMount className="data-[state=inactive]:hidden">
							{section("agent")}
						</TabsContent>
						<TabsContent value="global" forceMount className="data-[state=inactive]:hidden">
							{section("global")}
						</TabsContent>
					</Tabs>
				)}
			</fieldset>
		</>
	);
}
