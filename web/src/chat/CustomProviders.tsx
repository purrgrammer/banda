/**
 * Settings' servers of the owner's (`src/core/custom-providers.ts`): each says where it sends what the band says, how it
 * charges and what it runs; Check is the one request the app makes to it to see it answer, asked first with the address
 * and the model it will use, and it may cost; Edit opens its form (`./ServerSetup.tsx`). Removing one the band or an
 * agent still runs on is refused by the daemon, which says what to move first.
 */
import { type ComponentProps, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { type CheckFailure, type Destination, modelName, SERVER_KINDS } from "../../../src/core/custom-providers.ts";
import { TIERS } from "../../../src/core/tiers.ts";
import type { Checked, CustomProviderSave, CustomProviderView } from "../areas/custom-providers.ts";
import { ServerMark } from "./ProviderMark.tsx";
import { ServerSetup } from "./ServerSetup.tsx";
import { Block, RowOf, Rows } from "./Settings.tsx";

/** Where an address sends things, in the owner's words; on a phone, the computer is still banda's, never the phone. */
export function placeWords(destination: Pick<Destination, "place" | "secure">, here: boolean): string {
	if (destination.place === "computer")
		return here ? "On this computer" : "On the computer banda runs on, not this phone";
	if (destination.place === "network") return destination.secure ? "On your network" : "On your network, over http";
	return "On the internet";
}

/** A check's outcome in a line. */
export function checkedWords(checked: Checked, host: string): string {
	if (!checked.ok) return failureWords(checked.failure, host);
	const reply = checked.reply === "" ? "an empty answer" : `“${checked.reply.slice(0, 60)}”`;
	return `Answered in ${checked.ms} ms with ${checked.model}: ${reply}`;
}

/** What a failed check means, and what to do, in the owner's words: from the request, never from its error's text. */
export function failureWords(failure: CheckFailure, host: string): string {
	switch (failure) {
		case "timeout":
			return "No answer in 30 seconds. A local model may still be loading: try again in a moment.";
		case "unreachable":
			return `Nothing answered at ${host}. Is the server running, and reachable from the computer banda runs on?`;
		case "unknown-host":
			return `${host} can't be found. Check the address.`;
		case "certificate":
			return "Its certificate couldn't be verified, so nothing was sent. Check the address, or the server's certificate.";
		case "redirect":
			return "It sends banda to another address, which banda doesn't follow. Write the address it redirects to.";
		case "auth":
			return "It refused the key. Check the key in Edit, or whether it needs one at all.";
		case "not-found":
			return "It has no such model, or no API at that address. Check the model id, and that the address ends where its API starts (often /v1).";
		case "rejected":
			return "It refused the request. Check the model id; if that's right, try the compatibility settings in Edit.";
		case "limited":
			return "It's limiting requests, or the account is out of credit. Try again later.";
		case "server":
			return "It failed on its own side. Check the server and its logs, then try again.";
		case "unreadable":
			return "It answered, but not the way OpenAI's chat completions do. Try the compatibility settings in Edit.";
		default:
			return "It didn't answer as expected.";
	}
}

/**
 * The owner's servers, each with where it sends things and how it stands; Use, Check and Edit. Adding one is the Add a
 * provider dialog's (`./AddProvider.tsx`). `form` and `asking` open a server's form or a check's question at first, for
 * the specimen.
 */
export function CustomProviders({
	view,
	current,
	here = true,
	checking,
	error,
	onEdit,
	list,
	onRemove,
	onUse,
	onCheck,
	form: openForm,
	asking: openAsking,
	bare = false,
}: {
	/** Its rows alone, inside the providers' list, rather than a block of its own. */
	bare?: boolean;
	view: { readonly providers: readonly CustomProviderView[]; readonly error?: string } | undefined;
	/** The provider the band thinks with. */
	current: string;
	/** On the computer banda runs on; false on a phone, where localhost is still that computer. */
	here?: boolean;
	/** The provider a check is under way for. */
	checking?: string | undefined;
	error?: string | undefined;
	/** Each resolves with why it was refused, or undefined. */
	/** Ask a server for its list of models, from its form. */
	list?: ComponentProps<typeof ServerSetup>["list"];
	onEdit?: ((id: string, save: CustomProviderSave) => Promise<string | undefined>) | undefined;
	onRemove?: ((id: string) => Promise<string | undefined>) | undefined;
	onUse?: ((id: string) => void) | undefined;
	onCheck?: ((id: string) => void) | undefined;
	form?: string | undefined;
	asking?: string | undefined;
}) {
	const [form, setForm] = useState<string | undefined>(openForm);
	const [asking, setAsking] = useState<string | undefined>(openAsking);
	/** The control that opened the form or the check's question: focus goes back to it when they close. */
	const opener = useRef<HTMLElement | null>(null);
	const opened = (event: { currentTarget: HTMLElement }) => {
		opener.current = event.currentTarget;
	};
	const back = (event: Event) => {
		if (opener.current?.isConnected !== true) return;
		event.preventDefault();
		opener.current.focus();
	};
	const providers = view?.providers ?? [];
	const editing = form === undefined ? undefined : providers.find((row) => row.id === form);
	const ask = providers.find((row) => row.id === asking);
	const others = (id?: string) => providers.filter((row) => row.id !== id).map((row) => row.name);
	const rows = providers.map((row) => {
		const using = row.id === current;
		const mapped = TIERS.every((tier) => row.models.some((model) => model.id === row.tiers[tier]));
		const ready = row.key !== "missing" && mapped;
		const notes = [
			using ? "In use" : undefined,
			placeWords(row.destination, here),
			row.key === "missing" ? "Needs its key: edit it" : undefined,
			mapped ? undefined : "No model for each tier yet: edit it",
		].filter(Boolean);
		return (
			<div key={row.id} className="flex flex-col" data-custom-provider={row.id}>
				<RowOf
					lead={<ServerMark kind={row.kind} className="size-5" />}
					title={row.name}
					detail={
						<>
							{notes.join(" · ")}
							<span className="block break-all" data-address>
								{row.baseUrl}
							</span>
						</>
					}
					end={
						<span className="flex shrink-0 flex-wrap justify-end gap-1.5">
							{!using && ready ? (
								<Button variant="outline" size="xs" aria-label={`Use ${row.name}`} onClick={() => onUse?.(row.id)}>
									Use
								</Button>
							) : null}
							<Button
								variant="ghost"
								size="xs"
								aria-label={`Check ${row.name}`}
								disabled={checking === row.id || row.key === "missing"}
								onClick={(event) => {
									opened(event);
									setAsking(row.id);
								}}
							>
								{checking === row.id ? <Spinner className="size-3" /> : null}
								Check
							</Button>
							<Button
								variant="ghost"
								size="xs"
								aria-label={`Edit ${row.name}`}
								onClick={(event) => {
									opened(event);
									setForm(row.id);
								}}
							>
								Edit
							</Button>
						</span>
					}
				/>
				{row.checked === undefined || checking === row.id ? null : (
					<div
						role="status"
						className={cn(
							"border-t border-line-soft px-3.5 py-2 pl-[2.875rem] text-meta break-words",
							row.checked.ok ? "text-ink-2" : "text-danger",
						)}
					>
						{checkedWords(row.checked, row.destination.host)}
						{row.checked.ok ? null : (
							<details className="mt-1 text-ink-2">
								<summary className="cursor-pointer">Details</summary>
								<span className="break-all">
									{row.checked.status === undefined ? "" : `HTTP ${row.checked.status} · `}
									{row.checked.detail}
								</span>
							</details>
						)}
					</div>
				)}
			</div>
		);
	});
	const problems = [
		view?.error === undefined
			? undefined
			: `banda could not read your servers, so none of them can think until this is fixed: ${view.error}`,
		error,
	].flatMap((each) =>
		each === undefined
			? []
			: [
					<p key={each} role="alert" className={cn("text-ui text-danger", bare && "px-3.5 py-2.5")}>
						{each}
					</p>,
				],
	);
	const body = (
		<>
			{bare ? rows : <Rows>{rows}</Rows>}
			{problems}
			<Dialog open={editing !== undefined} onOpenChange={(open) => (open ? undefined : setForm(undefined))}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" onCloseAutoFocus={back}>
					<DialogHeader>
						<DialogTitle>{editing === undefined ? "" : `Edit ${editing.name}`}</DialogTitle>
						<DialogDescription>
							{editing === undefined ? "" : `${SERVER_KINDS[editing.kind].label}. Saving doesn't contact it.`}
						</DialogDescription>
					</DialogHeader>
					{editing === undefined ? null : (
						<ServerSetup
							key={editing.id}
							kind={editing.kind}
							here={here}
							initial={editing}
							others={others(editing.id)}
							list={list}
							onCancel={() => setForm(undefined)}
							onSave={async (save) => {
								const why = await onEdit?.(editing.id, save);
								if (why === undefined) setForm(undefined);
								return why;
							}}
							{...(onRemove === undefined
								? {}
								: {
										onRemove: async () => {
											const why = await onRemove(editing.id);
											if (why === undefined) setForm(undefined);
											return why;
										},
									})}
						/>
					)}
				</DialogContent>
			</Dialog>
			<AlertDialog open={ask !== undefined} onOpenChange={(open) => (open ? undefined : setAsking(undefined))}>
				{ask === undefined ? null : (
					<AlertDialogContent size="sm" onCloseAutoFocus={back}>
						<AlertDialogHeader>
							<AlertDialogTitle>Check {ask.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								banda sends one short message to {ask.destination.host} (
								{placeWords(ask.destination, here).toLowerCase()}) with{" "}
								{modelName(ask.models.find((model) => model.id === ask.tiers.quick) ?? ask.models[0] ?? { id: "?" })}{" "}
								and waits for its answer. If it charges, this costs a few tokens.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									setAsking(undefined);
									onCheck?.(ask.id);
								}}
							>
								Send the check
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				)}
			</AlertDialog>
		</>
	);
	return bare ? (
		body
	) : (
		<Block title="Your own servers" note="Servers you added, by their address.">
			{body}
		</Block>
	);
}
