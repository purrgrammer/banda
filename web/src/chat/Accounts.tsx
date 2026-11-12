/**
 * A connection's accounts, wherever they are acted on (its page, the MCP setup once connected): each account is one row
 * with its name, the agents that use it and a menu of what acts on it; what adds one is below the list, "Add account",
 * or a single "Connect" while there is none. Signing out is asked first, saying who loses access.
 */
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AccountView } from "../../../src/server/api.ts";
import type { ScopeChoices } from "../lib/connect.ts";
import { Confirm } from "./Confirm.tsx";

/** The access an account was given, in the definition's words where they name it; else the scopes as they are. */
export function accessWords(account: Pick<AccountView, "scopes" | "stale">, access: ScopeChoices | undefined): string {
	if (account.stale === true) return "Its sign-in no longer fits this connection";
	const scopes = account.scopes ?? [];
	const labels =
		access?.choices
			.filter((choice) => choice.scopes.every((scope) => scopes.includes(scope)))
			.map((choice) => choice.label) ?? [];
	return labels.length > 0 ? labels.join(" · ") : "Signed in";
}

const listOf = (names: readonly string[]) =>
	names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * What signing out of account `label` asks, for the agents it is on for, by name: what the daemon's sign-out does. In
 * one commit the account is off for every agent, the permissions bound to it are taken back, its watches end, and the
 * drafts waiting on it end; its credentials are forgotten.
 */
export function signOutWords(label: string, names: readonly string[]): { title: string; body: string } {
	const who =
		names.length === 0
			? `No agent uses ${label}.`
			: `${listOf(names)} ${names.length === 1 ? "loses" : "lose"} access to ${label}.`;
	return {
		title: `Sign out of ${label}?`,
		body: `${who} Its sign-in is forgotten, and the permissions, watches and waiting drafts that use it end. You can sign in again.`,
	};
}

/** A row's menu: what acts on the one thing the row is, behind "⋯", with a 44px target on a phone. */
export function RowMenu({
	label,
	items,
	disabled = false,
}: {
	/** What the row is, as the owner reads it: the menu is "More for" it. */
	label: string;
	items: readonly { readonly words: string; readonly onSelect: () => void }[];
	disabled?: boolean | undefined;
}) {
	if (items.length === 0) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0 max-sm:size-11"
					aria-label={`More for ${label}`}
					disabled={disabled}
				>
					<EllipsisIcon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{items.map((item) => (
					<DropdownMenuItem key={item.words} className="max-sm:min-h-11" onSelect={item.onSelect}>
						{item.words}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The accounts of a connection that signs in, one row each, and below them what adds one. `onSignOut` is called only
 * once the owner confirmed; without `onAdd` nothing adds, and without an action its item is not offered.
 */
export function AccountList({
	accounts,
	agents,
	access,
	busy = false,
	onAdd,
	onChangeAccess,
	onSignOut,
}: {
	accounts: readonly AccountView[];
	/** The band's agents, to name the ones an account is on for. */
	agents: readonly { readonly id: string; readonly name: string }[];
	access?: ScopeChoices | undefined;
	busy?: boolean | undefined;
	onAdd?: (() => void) | undefined;
	onChangeAccess?: ((account: AccountView) => void) | undefined;
	onSignOut?: ((account: AccountView) => void) | undefined;
}) {
	const [leaving, setLeaving] = useState<AccountView>();
	const namesOf = (account: AccountView) =>
		account.agents.map((id) => agents.find((each) => each.id === id)?.name ?? id);
	const asked = leaving === undefined ? undefined : signOutWords(leaving.label, namesOf(leaving));
	return (
		<div className="flex min-w-0 flex-col gap-2">
			{accounts.length === 0 ? null : (
				<ul className="flex flex-col divide-y divide-line-soft rounded-field border border-line-soft">
					{accounts.map((account) => {
						const names = namesOf(account);
						const given = accessWords(account, access);
						return (
							<li
								key={account.account}
								className="flex items-center justify-between gap-2 py-2 pr-2 pl-3.5"
								data-account={account.account}
							>
								<span className="flex min-w-0 flex-col">
									<span className="flex flex-wrap items-center gap-1.5 break-words text-ui text-ink">
										{account.label}
										{account.stale ? <Badge variant="secondary">Sign in again</Badge> : null}
									</span>
									<span className="break-words text-meta text-ink-2">
										{names.length === 0 ? "No agent uses it" : names.join(", ")}
									</span>
									{/* a sign-in with nothing to tell of its access says nothing more */}
									{given === "Signed in" ? null : <span className="text-meta text-ink-2">{given}</span>}
									{account.missing ? (
										<span className="text-meta text-ink-2">Needs more access for some tools</span>
									) : null}
								</span>
								<RowMenu
									label={account.label}
									disabled={busy}
									items={[
										...(onChangeAccess === undefined
											? []
											: [
													{
														words: account.stale ? "Sign in again" : "Change access",
														onSelect: () => onChangeAccess(account),
													},
												]),
										...(onSignOut === undefined ? [] : [{ words: "Sign out", onSelect: () => setLeaving(account) }]),
									]}
								/>
							</li>
						);
					})}
				</ul>
			)}
			{onAdd === undefined ? null : accounts.length === 0 ? (
				<Button size="sm" className="self-start" disabled={busy} onClick={onAdd}>
					Connect
				</Button>
			) : (
				<Button variant="ghost" size="sm" className="-ml-2 self-start" disabled={busy} onClick={onAdd}>
					<PlusIcon data-icon="inline-start" />
					Add account
				</Button>
			)}
			{leaving === undefined || asked === undefined ? null : (
				<Confirm
					open
					onOpenChange={(open) => {
						if (!open) setLeaving(undefined);
					}}
					title={asked.title}
					body={asked.body}
					action="Sign out"
					keep="Stay connected"
					onConfirm={() => {
						setLeaving(undefined);
						onSignOut?.(leaving);
					}}
				/>
			)}
		</div>
	);
}
