/**
 * Connecting a harness, in one dialog with three steps: which harness (those on this computer, those to install, or
 * one's own command line), the code folder (browsed, or typed), and a review that says plainly what it may do and for
 * which agents. Connect and Edit open it on their harness; an agent's Access opens it with that agent on.
 */
import { CheckIcon, InfoIcon, ShieldAlertIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addHarness, connectHarness, foldersAt, removeHarness, switchHarness } from "../areas/harnesses.ts";
import { Confirm } from "../chat/Confirm.tsx";
import { FolderBrowser, folderName, projectsIn, projectsWord } from "../chat/FolderPicker.tsx";
import { HarnessMark } from "../chat/Harness.tsx";
import type { FolderListing } from "../lib/api.ts";
import { chatAgents } from "../lib/navigation.ts";
import { useShell } from "../lib/shell.ts";

type Step = "pick" | "own" | "folder" | "review";

/** The words a harness that asks nothing of its own is shipped with, or given: its own settings decide. */
const ASKS_NOTHING = /own settings|runs its tools without asking/;

export function HarnessDialog({
	open,
	onOpenChange,
	harness: given,
	agent,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The harness it is about; none, and it starts by picking one. */
	harness?: string | undefined;
	/** The agent whose Access opened it: on for it from the start. */
	agent?: { readonly id: string; readonly name: string } | undefined;
}) {
	const shell = useShell();
	const view = shell.harnesses;
	const current = useRef(view);
	current.current = view;
	const agents = useMemo(
		() => (shell.companion === undefined ? [] : chatAgents(shell.agents, shell.companion)),
		[shell.agents, shell.companion],
	);
	const [step, setStep] = useState<Step>(given === undefined ? "pick" : "folder");
	const [name, setName] = useState<string | undefined>(given);
	const [folder, setFolder] = useState("");
	const [listing, setListing] = useState<FolderListing | undefined>(undefined);
	const [on, setOn] = useState<ReadonlySet<string>>(new Set());
	const [own, setOwn] = useState({ service: "", command: "" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const account = name === undefined ? undefined : view?.accounts[name];
	const chosen = view?.harnesses.find((one) => one.name === name);
	const agentId = agent?.id;
	// each time it opens, it starts from what is so now
	useEffect(() => {
		if (!open) return;
		setStep(given === undefined ? "pick" : "folder");
		setName(given);
		setError(undefined);
		setOwn({ service: "", command: "" });
		// what is so now is read when it opens: the shell's later pushes do not reset the steps
		const now = given === undefined ? undefined : current.current?.accounts[given];
		setFolder(now?.folder ?? current.current?.suggested ?? "~");
		setOn(new Set([...(now?.agents ?? []), ...(agentId === undefined ? [] : [agentId])]));
		// by the agent's id: the object is made anew on every render of the tile that opened it
	}, [open, given, agentId]);
	const onAt = useCallback((path: string, found: FolderListing) => {
		setFolder(path);
		setListing(found);
	}, []);
	const pick = (harness: string) => {
		setName(harness);
		const now = view?.accounts[harness];
		setFolder(now?.folder ?? view?.suggested ?? "~");
		setOn(new Set([...(now?.agents ?? []), ...(agent === undefined ? [] : [agent.id])]));
		setStep("folder");
	};
	const failed = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
	const addOwn = () => {
		setBusy(true);
		setError(undefined);
		addHarness(own.service.trim(), own.command.trim())
			.then((after) => {
				const added = after.harnesses.find((one) => one.service === own.service.trim() && one.custom === true);
				if (added !== undefined) pick(added.name);
			}, failed)
			.finally(() => setBusy(false));
	};
	const save = async () => {
		if (name === undefined) return;
		setBusy(true);
		setError(undefined);
		try {
			await connectHarness(name, folder);
			const before = new Set(account?.agents ?? []);
			for (const one of agents) {
				const wanted = on.has(one.id);
				if (wanted !== before.has(one.id)) await switchHarness(name, one.id, wanted);
			}
			onOpenChange(false);
		} catch (reason) {
			failed(reason);
		} finally {
			setBusy(false);
		}
	};
	const service = chosen?.service ?? name ?? "a harness";
	const asksNothing = chosen?.custom === true || ASKS_NOTHING.test(chosen?.asks ?? "");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-4 sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{step === "pick" || step === "own"
							? "Add a harness"
							: account === undefined
								? `Connect ${service}`
								: `${service}`}
					</DialogTitle>
					<DialogDescription>
						{step === "pick"
							? "A coding agent on this computer your agents can hand work to."
							: step === "own"
								? "Any coding agent that speaks ACP, by the command that starts it so."
								: step === "folder"
									? "The folder your projects are in. Each task works in one of them."
									: "What it may do, and for whom."}
					</DialogDescription>
				</DialogHeader>
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
					{step === "pick" ? (
						<ul className="flex flex-col divide-y divide-line-soft overflow-hidden rounded-field border border-line-soft">
							{(view?.harnesses ?? []).map((one) => (
								<li key={one.name}>
									<button
										type="button"
										onClick={() => pick(one.name)}
										className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-paper-3"
									>
										<span className="flex size-8 shrink-0 items-center justify-center rounded-field bg-paper-3">
											<HarnessMark provider={one.provider} logo={one.logo} className="size-5" />
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="text-ui font-medium text-ink">{one.service}</span>
											<span className="truncate text-meta text-ink-2">
												{view?.accounts[one.name] === undefined
													? (one.about ?? "On this computer")
													: `Connected in ${view.accounts[one.name]?.folder}`}
											</span>
										</span>
										{view?.accounts[one.name] === undefined ? null : <CheckIcon className="size-4 text-ink-2" />}
									</button>
								</li>
							))}
							{(view?.missing ?? []).map((one) => (
								<li key={one.name} className="flex flex-col gap-2 px-3 py-2.5">
									<span className="flex items-center gap-3">
										<span className="flex size-8 shrink-0 items-center justify-center rounded-field bg-paper-3 opacity-60">
											<HarnessMark provider={one.provider} logo={one.logo} className="size-5" />
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="text-ui font-medium text-ink-2">{one.service}</span>
											<span className="text-meta text-ink-2">Not installed on this computer</span>
										</span>
									</span>
									{one.install === undefined ? null : (
										<span className="flex min-w-0 items-center gap-2 rounded-field bg-paper-2 px-3 py-1.5">
											<code className="min-w-0 flex-1 font-code text-meta break-all text-ink">{one.install}</code>
											<CodeBlockCopyButton text={one.install} label={`Copy how to install ${one.service}`} />
										</span>
									)}
								</li>
							))}
							<li>
								<button
									type="button"
									onClick={() => setStep("own")}
									className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-paper-3"
								>
									<span className="flex size-8 shrink-0 items-center justify-center rounded-field bg-paper-3">
										<TerminalIcon className="size-4 text-ink-2" />
									</span>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="text-ui font-medium text-ink">Another, by its command</span>
										<span className="text-meta text-ink-2">Any coding agent that speaks ACP</span>
									</span>
								</button>
							</li>
						</ul>
					) : step === "own" ? (
						<>
							<label className="flex flex-col gap-1.5" htmlFor="harness-own-service">
								<span className="text-meta text-ink-2">What you call it</span>
								<Input
									id="harness-own-service"
									value={own.service}
									placeholder="Goose"
									onChange={(event) => setOwn({ ...own, service: event.target.value })}
								/>
							</label>
							<label className="flex flex-col gap-1.5" htmlFor="harness-own-command">
								<span className="text-meta text-ink-2">The command that starts it speaking ACP</span>
								<Input
									id="harness-own-command"
									value={own.command}
									className="font-code"
									placeholder="goose acp"
									onChange={(event) => setOwn({ ...own, command: event.target.value })}
								/>
							</label>
							<Alert variant="destructive">
								<ShieldAlertIcon />
								<AlertTitle>It runs on your computer as you</AlertTitle>
								<AlertDescription>
									banda starts this command whenever an agent hands it work. Add only one you trust.
								</AlertDescription>
							</Alert>
						</>
					) : step === "folder" ? (
						<FolderBrowser at={folder} browse={foldersAt} onAt={onAt} />
					) : (
						<>
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-field bg-paper-2 px-3.5 py-3 text-ui">
								<dt className="text-ink-2">Harness</dt>
								<dd className="flex min-w-0 items-center gap-2 text-ink">
									<HarnessMark provider={chosen?.provider} logo={chosen?.logo} className="size-4" />
									{service}
								</dd>
								<dt className="text-ink-2">Code folder</dt>
								<dd className="min-w-0 font-code text-meta break-all text-ink">
									{folder}
									{listing === undefined ? "" : ` · ${projectsWord(projectsIn(listing)) || "no projects yet"}`}
								</dd>
							</dl>
							<fieldset className="flex flex-col gap-2">
								<legend className="mb-1.5 text-meta text-ink-2">Agents that may hand it work</legend>
								{agents.map((one) => (
									<label
										key={one.id}
										className="flex items-center gap-2.5 text-ui text-ink"
										htmlFor={`harness-on-${one.id}`}
									>
										<Checkbox
											id={`harness-on-${one.id}`}
											checked={on.has(one.id)}
											onCheckedChange={(next) => {
												const after = new Set(on);
												if (next === true) after.add(one.id);
												else after.delete(one.id);
												setOn(after);
											}}
										/>
										{one.name}
									</label>
								))}
							</fieldset>
							{asksNothing ? (
								<Alert variant="destructive">
									<ShieldAlertIcon />
									<AlertTitle>It asks you nothing</AlertTitle>
									<AlertDescription>
										An agent starts it without asking, and {service} runs what it decides to on your computer, unless
										its own settings ask. Turn it on only for agents whose chats you trust.
									</AlertDescription>
								</Alert>
							) : (
								<Alert>
									<InfoIcon />
									<AlertTitle>What it asks you</AlertTitle>
									<AlertDescription>
										{chosen?.asks} An agent starts it without asking you; its asks come to you in the chat, and you can
										steer or stop it there.
									</AlertDescription>
								</Alert>
							)}
							<p className="text-meta text-ink-2">
								The code folder selects where work starts; it is not a sandbox. {service} runs on your computer with
								your sign-in and its own permissions, including access you already granted outside that folder. Enabling
								it lets your agent start work without another approval. Only one-time approvals are supported in banda;
								unsupported choices are refused. If its required permission mode cannot be set, banda stops the session
								before sending work.
							</p>
						</>
					)}
					{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
				</div>
				{step === "pick" ? null : (
					<DialogFooter>
						{chosen?.custom === true && (step === "folder" || step === "review") ? (
							<Confirm
								title={`Remove ${service}?`}
								body="banda forgets the command that starts it, and disconnects it."
								action="Remove"
								onConfirm={() => void removeHarness(chosen.name).then(() => onOpenChange(false), failed)}
							>
								<Button variant="destructive" className="sm:mr-auto">
									Remove
								</Button>
							</Confirm>
						) : null}
						{step === "folder" && given === undefined ? (
							<Button variant="ghost" onClick={() => setStep("pick")}>
								Back
							</Button>
						) : step === "review" ? (
							<Button variant="ghost" onClick={() => setStep("folder")}>
								Back
							</Button>
						) : step === "own" ? (
							<Button variant="ghost" onClick={() => setStep("pick")}>
								Back
							</Button>
						) : null}
						{step === "own" ? (
							<Button disabled={busy || own.service.trim() === "" || own.command.trim() === ""} onClick={addOwn}>
								Add
							</Button>
						) : step === "folder" ? (
							<Button disabled={folder.trim() === ""} onClick={() => setStep("review")}>
								Use {folderName(folder)}
							</Button>
						) : step === "review" ? (
							<Button disabled={busy} onClick={() => void save()}>
								{account === undefined ? `Connect ${service}` : "Save"}
							</Button>
						) : null}
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
