/**
 * Connections: what the band can work with, one tile per service. Reached from the band's foot and from Settings, so
 * the owner can connect before any agent needs it. A service shows its accounts once signed in; one not shipped yet
 * says so, and is not a button. What waits on the owner (an account to sign in to again, a server not reached) shows on
 * its tile with the band menu's dot.
 */
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { scopeChoicesOf } from "../lib/connect.ts";
import { ConnectionIcon } from "./ConnectionIcon.tsx";

export type Service = {
	readonly id: string;
	readonly name: string;
	readonly url?: string | undefined;
	/** What it lets the band do, in a few words. */
	readonly does: string;
	/** Accounts signed in to it; undefined when the service is not shipped yet. */
	readonly accounts?: readonly string[] | undefined;
	readonly managed?: boolean;
	/** Accounts whose sign-in no longer fits the connection: the owner signs in again. */
	readonly stale?: readonly string[] | undefined;
	/** Why the connection is not reached, in words. */
	readonly problem?: string | undefined;
	/** banda ships a newer version of it: update to it, keeping the owner's scopes and sign-ins; rejects with why. */
	readonly onUpdate?: (() => Promise<unknown>) | undefined;
};

/** Updating a shipped connection: offered, under way, or refused with the daemon's words. */
type Updating =
	| { readonly state: "offered" }
	| { readonly state: "updating" }
	| { readonly state: "refused"; readonly why: string };

/** The line on a tile that offers banda's newer version of the connection, with its button. */
function UpdateOffer({ name, onUpdate }: { name: string; onUpdate: () => Promise<unknown> }) {
	const [updating, setUpdating] = useState<Updating>({ state: "offered" });
	return (
		<span className="flex flex-wrap items-center gap-2 text-meta text-ink">
			<span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-ink" />
			<span className="min-w-0 flex-1">
				{updating.state === "refused" ? updating.why : `banda has a newer ${name}: it can do more with your accounts.`}
			</span>
			<Button
				variant="outline"
				size="xs"
				disabled={updating.state === "updating"}
				onClick={() => {
					setUpdating({ state: "updating" });
					onUpdate().then(
						() => setUpdating({ state: "offered" }),
						(error: unknown) => setUpdating({ state: "refused", why: (error as Error).message }),
					);
				}}
			>
				{updating.state === "updating" ? "Updating…" : "Update"}
			</Button>
		</span>
	);
}

export function Catalogue({
	services,
	connect,
	onManage,
	extra = [],
}: {
	services: readonly Service[];
	/** Whole cards of their own in the grid (a harness on this computer), after what can be connected, before what is coming. */
	extra?: readonly { readonly key: string; readonly card: ReactNode }[];
	onManage?: (id: string) => void;
	/** The connect dialog for a service, opened by its tile's Connect, Sign in again, Manage access or Add account. */
	connect?: ((service: Service, close: () => void) => ReactNode) | undefined;
}) {
	const [open, setOpen] = useState<string | undefined>(undefined);
	return (
		<ul className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2">
			{[
				...services.filter((each) => each.accounts !== undefined),
				...extra,
				...services.filter((each) => each.accounts === undefined),
			].map((item) => {
				if ("card" in item)
					return (
						// a card of its own fills its cell: every tile in the grid the same size
						<li key={item.key} className="flex flex-col [&>*]:flex-1">
							{item.card}
						</li>
					);
				const service = item;
				const soon = service.accounts === undefined;
				const stale = soon ? [] : (service.stale ?? []);
				const problem = soon ? undefined : service.problem;
				return (
					<li
						key={service.id}
						className={cn("flex flex-col gap-3 rounded-tile border border-line-soft p-4", soon && "bg-paper-2")}
					>
						<span className="flex items-center gap-3">
							<span className="flex size-10 shrink-0 items-center justify-center rounded-field bg-paper-3">
								<ConnectionIcon connection={service.id} url={service.url} className="size-5" />
							</span>
							<span className="flex min-w-0 flex-col">
								<span className={cn("text-ui font-semibold", soon ? "text-ink-2" : "text-ink")}>{service.name}</span>
								<span className="text-meta text-ink-2">{service.does}</span>
							</span>
						</span>
						{stale.length > 0 || problem !== undefined ? (
							<span className="flex items-start gap-2 text-meta text-ink">
								<span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink" />
								<span className="flex flex-col">
									{stale.length > 0 ? <span>Sign in again: {stale.join(", ")}</span> : null}
									{problem === undefined ? null : <span>{problem}</span>}
								</span>
							</span>
						) : null}
						{soon || service.onUpdate === undefined ? null : (
							<UpdateOffer name={service.name} onUpdate={service.onUpdate} />
						)}
						{soon ? (
							<span className="text-meta text-ink-2">Coming soon</span>
						) : service.managed ? (
							<>
								<span className="text-meta text-ink-2">{service.accounts.join(", ")}</span>
								<Button variant="outline" size="sm" className="self-start" onClick={() => onManage?.(service.id)}>
									Manage connection
								</Button>
							</>
						) : service.accounts.length === 0 ? (
							<Button size="sm" className="self-start" onClick={() => setOpen(service.id)}>
								{stale.length > 0 ? "Sign in again" : "Connect"}
							</Button>
						) : (
							<span className="flex flex-wrap items-center gap-2">
								<span className="text-meta text-ink-2">{service.accounts.join(", ")}</span>
								<Button
									variant={stale.length > 0 ? "outline" : "ghost"}
									size="xs"
									className="ml-auto"
									onClick={() => setOpen(service.id)}
								>
									{stale.length > 0
										? "Sign in again"
										: scopeChoicesOf(service.id) !== undefined
											? "Manage access"
											: "Add account"}
								</Button>
							</span>
						)}
						{open === service.id && connect !== undefined ? connect(service, () => setOpen(undefined)) : null}
					</li>
				);
			})}
		</ul>
	);
}
