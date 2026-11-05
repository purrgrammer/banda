/**
 * "+" (DESIGN.md "The app"): a new agent, the chat-bubble face picked for you, a name and a personality (three starters to begin
 * from); or a new group, who is in it and its name. Naming a friend, not filling a form. The agent's file is written
 * as the owner's own and is in effect at once; its chat opens.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { agentId } from "../../../src/core/agent-id.ts";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { createGroup } from "../areas/groups.ts";
import { Face } from "../chat/Face.tsx";
import { FaceAndName, Personality } from "../chat/Settings.tsx";
import type { Who } from "../chat/types.ts";
import { saveAgent } from "../lib/api.ts";
import type { ChatAgent } from "../lib/navigation.ts";
import { agentFile } from "./edit-file.ts";
import type { Where } from "./where.ts";

export function NewSheet({
	open,
	onOpenChange,
	agents,
	onGo,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: readonly ChatAgent[];
	onGo: (where: Where) => void;
}) {
	const [kind, setKind] = useState<"agent" | "group">("agent");
	const [who, setWho] = useState<Who>(() => ({ face: defaultAvatarFace(), name: "" }));
	const [personality, setPersonality] = useState("");
	const [members, setMembers] = useState<readonly string[]>([]);
	const [typedName, setGroupName] = useState<string | undefined>(undefined);
	// until the owner names it, the group's name follows who is in it: "Sancho & Mara"
	const memberNames = members.map((member) => agents.find((agent) => agent.id === member)?.name ?? member);
	const groupName =
		typedName ??
		(memberNames.length <= 1
			? (memberNames[0] ?? "")
			: `${memberNames.slice(0, -1).join(", ")} & ${memberNames.at(-1)}`);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const taken = new Set(agents.map((agent) => agent.id));
	const id = agentId(who.name);
	const ready =
		kind === "agent" ? who.name.trim() !== "" && !taken.has(id) : members.length >= 2 && groupName.trim() !== "";

	const create = async () => {
		setError(undefined);
		setBusy(true);
		try {
			if (kind === "agent") {
				await saveAgent(id, agentFile(who, personality));
				onGo({ name: "agent", id });
			} else {
				const { room } = await createGroup(members, groupName.trim());
				onGo({ name: "group", room });
			}
			onOpenChange(false);
		} catch (failed) {
			const why = (failed as Error).message;
			setError(
				/docker|computer|box/i.test(why)
					? `The band's computer isn't running, so ${kind === "agent" ? who.name || "the agent" : "the group"} can't be added yet. Try again once it has started.`
					: why,
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden rounded-tile p-0 sm:max-w-md">
				<div className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
					<DialogTitle className="text-ui font-semibold text-ink">New</DialogTitle>
					<div role="radiogroup" aria-label="Make" className="flex rounded-field bg-paper-3 p-0.5">
						{(["agent", "group"] as const).map((one) => (
							// biome-ignore lint/a11y/useSemanticElements: a segment of a segmented control
							<button
								key={one}
								type="button"
								role="radio"
								aria-checked={kind === one}
								onClick={() => setKind(one)}
								className={cn(
									"rounded-[6px] px-3 py-1 text-ui text-ink-2",
									kind === one && "bg-paper font-medium text-ink shadow-[0_0_0_1px_var(--line-soft)]",
								)}
							>
								{one === "agent" ? "Agent" : "Group"}
							</button>
						))}
					</div>
				</div>
				<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">
					{kind === "agent" ? (
						<>
							<FaceAndName who={who} onChange={setWho} autoFocus />
							{who.name.trim() !== "" && taken.has(id) ? (
								<p className="-mt-3 text-meta text-danger">
									There is already an agent called {who.name}. Pick another name.
								</p>
							) : null}
							<Personality starters onChange={setPersonality} />
						</>
					) : (
						<>
							{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
							<label className="flex flex-col gap-1.5">
								<span className="text-ui font-medium text-ink">Name</span>
								<Input
									value={groupName}
									onChange={(event) => setGroupName(event.target.value)}
									placeholder="Trip"
									className="text-heading"
								/>
							</label>
							<div className="flex flex-col gap-2">
								<p className="text-ui font-medium text-ink">Who's in it</p>
								<p className="text-meta text-ink-2">Two or more. A message asks everyone unless it mentions one.</p>
								<div className="flex flex-col divide-y divide-line-soft overflow-hidden rounded-tile border border-line-soft">
									{agents.map((agent) => (
										// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
										<label key={agent.id} className="flex h-12 items-center gap-3 px-3.5">
											<Face face={agent.face} name={agent.name} size="message" />
											<span className="flex-1 text-ui text-ink">{agent.name}</span>
											<Switch
												checked={members.includes(agent.id)}
												onCheckedChange={(on) =>
													setMembers((was) => (on ? [...was, agent.id] : was.filter((each) => each !== agent.id)))
												}
												aria-label={`${agent.name} in the group`}
											/>
										</label>
									))}
								</div>
							</div>
						</>
					)}
					{error === undefined ? null : (
						<p role="alert" className="text-ui text-danger">
							{error}
						</p>
					)}
				</div>
				<div className="flex gap-2 border-t border-line-soft px-4 py-3">
					<Button className="flex-1" disabled={!ready || busy} onClick={() => void create()}>
						{kind === "agent" ? "Add to the band" : "Start the group"}
					</Button>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
