/**
 * Harnesses where the owner manages them, on the daemon's data: the tiles of Connections, the rows of an agent's
 * Access, and "Add a harness"; each opens the connect dialog on its harness.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { disconnectHarness, switchHarness } from "../areas/harnesses.ts";
import { HarnessTile } from "../chat/Harness.tsx";
import { attempt } from "../lib/attempt.ts";
import { chatAgents } from "../lib/navigation.ts";
import { useShell } from "../lib/shell.ts";
import { HarnessDialog } from "./HarnessDialog.tsx";

/** Add a harness: the dialog from its first step; from an agent's Access, on for that agent. */
export function AddHarnessButton({
	agent,
	size,
}: {
	agent?: { readonly id: string; readonly name: string } | undefined;
	size?: "sm" | undefined;
} = {}) {
	const [open, setOpen] = useState(false);
	const unavailable = useShell().harnesses?.unavailable;
	if (unavailable !== undefined) return <p className="text-meta text-ink-2">{unavailable}</p>;
	return (
		<>
			<Button variant="outline" size={size} className="self-start" onClick={() => setOpen(true)}>
				Add a harness
			</Button>
			<HarnessDialog open={open} onOpenChange={setOpen} agent={agent} />
		</>
	);
}

/** A harness on Connections: where it works and for which agents; Connect or Edit (Remove, for the owner's own), Disconnect. */
export function HarnessConnectionTile({ name }: { name: string }) {
	const shell = useShell();
	const [open, setOpen] = useState(false);
	const names = useMemo(() => {
		const all = shell.companion === undefined ? [] : chatAgents(shell.agents, shell.companion);
		return new Map(all.map((one) => [one.id, one.name]));
	}, [shell.agents, shell.companion]);
	const harness = shell.harnesses?.harnesses.find((one) => one.name === name);
	if (harness === undefined) return null;
	const account = shell.harnesses?.accounts[name];
	return (
		<>
			<HarnessTile
				harness={harness.service}
				provider={harness.provider}
				logo={harness.logo}
				about={harness.about}
				connected={account?.folder}
				agents={account?.agents.map((id) => names.get(id) ?? id)}
				onConnect={() => setOpen(true)}
				onEdit={() => setOpen(true)}
				onDisconnect={() => void attempt("disconnect it", () => disconnectHarness(name))}
			/>
			<HarnessDialog open={open} onOpenChange={setOpen} harness={name} />
		</>
	);
}

/** A harness in an agent's Access: the switch for that agent once connected, else Connect, on for it. */
export function HarnessAccessTile({
	name,
	agent,
}: {
	name: string;
	agent: { readonly id: string; readonly name: string };
}) {
	const shell = useShell();
	const [open, setOpen] = useState(false);
	const harness = shell.harnesses?.harnesses.find((one) => one.name === name);
	if (harness === undefined) return null;
	const account = shell.harnesses?.accounts[name];
	return (
		<>
			<HarnessTile
				harness={harness.service}
				provider={harness.provider}
				logo={harness.logo}
				about={harness.about}
				connected={account?.folder}
				agent={agent.name}
				on={account?.agents.includes(agent.id) === true}
				onConnect={() => setOpen(true)}
				onEdit={() => setOpen(true)}
				onSwitch={(on) => void attempt(on ? "turn it on" : "turn it off", () => switchHarness(name, agent.id, on))}
			/>
			<HarnessDialog open={open} onOpenChange={setOpen} harness={name} agent={agent} />
		</>
	);
}
