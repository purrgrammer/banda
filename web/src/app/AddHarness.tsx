/**
 * Add a harness of the owner's own: any coding agent that speaks ACP, by what they call it and the command line that
 * starts it so (`goose acp`, `my-agent --acp`). It joins Connections, to connect in a folder like any other.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addHarness } from "../areas/harnesses.ts";

export function AddHarness() {
	const [open, setOpen] = useState(false);
	const [service, setService] = useState("");
	const [command, setCommand] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	if (!open)
		return (
			<Button variant="outline" className="self-start" onClick={() => setOpen(true)}>
				Add a harness
			</Button>
		);
	const add = () => {
		setBusy(true);
		setError(undefined);
		void addHarness(service.trim(), command.trim())
			.then(() => {
				setOpen(false);
				setService("");
				setCommand("");
			})
			.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)))
			.finally(() => setBusy(false));
	};
	return (
		<form
			className="flex w-full max-w-[var(--measure)] flex-col gap-3 rounded-tile border border-line-soft p-4"
			onSubmit={(event) => {
				event.preventDefault();
				add();
			}}
		>
			<span className="flex flex-col gap-0.5">
				<span className="text-ui font-semibold text-ink">Add a harness</span>
				<span className="text-meta text-ink-2">A coding agent that speaks ACP: the command that starts it so.</span>
			</span>
			<label className="flex flex-col gap-1.5" htmlFor="harness-service">
				<span className="text-meta text-ink-2">What you call it</span>
				<Input
					id="harness-service"
					value={service}
					placeholder="Goose"
					onChange={(event) => setService(event.target.value)}
				/>
			</label>
			<label className="flex flex-col gap-1.5" htmlFor="harness-command">
				<span className="text-meta text-ink-2">Its command</span>
				<Input
					id="harness-command"
					value={command}
					className="font-code"
					placeholder="goose acp"
					onChange={(event) => setCommand(event.target.value)}
				/>
			</label>
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
			<span className="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy || service.trim() === "" || command.trim() === ""}>
					Add
				</Button>
				<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
					Cancel
				</Button>
			</span>
		</form>
	);
}
