/**
 * Connections: what the band can work with, one tile per service. Reached from the band's foot and from Settings, so
 * the owner can connect before any agent needs it. A service shows its accounts once signed in. What waits on the owner
 * (an account to sign in to again, a server not reached) shows on its tile with the band menu's dot.
 */
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConnectionIcon } from "./ConnectionIcon.tsx";

export type Service = {
	readonly id: string;
	readonly name: string;
	readonly url?: string | undefined;
	/** What it lets the band do, in a few words. */
	readonly does: string;
	/** Accounts signed in to it. */
	readonly accounts: readonly string[];
	readonly managed?: boolean;
	/** Accounts whose sign-in no longer fits the connection: the owner signs in again. */
	readonly stale?: readonly string[] | undefined;
	/** Why the connection is not reached, in words. */
	readonly problem?: string | undefined;
	/** The owner chooses its access before signing in: a signed-in tile offers to change it. */
	readonly choices?: boolean | undefined;
};

export function Catalogue({
	services,
	connect,
	onManage,
	extra = [],
}: {
	services: readonly Service[];
	/** Whole cards of their own in the grid (a harness on this computer), after what can be connected. */
	extra?: readonly { readonly key: string; readonly card: ReactNode }[];
	onManage?: (id: string) => void;
	/** The connect dialog for a service, opened by its tile's Connect, Sign in again, Manage access or Add account. */
	connect?: ((service: Service, close: () => void) => ReactNode) | undefined;
}) {
	const [open, setOpen] = useState<string | undefined>(undefined);
	return (
		<ul className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2">
			{[...services, ...extra].map((item) => {
				if ("card" in item)
					return (
						// a card of its own fills its cell: every tile in the grid the same size
						<li key={item.key} className="flex flex-col [&>*]:flex-1">
							{item.card}
						</li>
					);
				const service = item;
				const stale = service.stale ?? [];
				const problem = service.problem;
				return (
					<li key={service.id} className="flex flex-col gap-3 rounded-tile border border-line-soft p-4">
						<span className="flex items-center gap-3">
							<span className="flex size-10 shrink-0 items-center justify-center rounded-field bg-paper-3">
								<ConnectionIcon connection={service.id} url={service.url} className="size-5" />
							</span>
							<span className="flex min-w-0 flex-col">
								<span className="text-ui font-semibold text-ink">{service.name}</span>
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
						{service.managed ? (
							<>
								<span className="text-meta text-ink-2">{service.accounts.join(", ")}</span>
								<Button variant="outline" size="sm" className="self-start" onClick={() => onManage?.(service.id)}>
									Details
								</Button>
							</>
						) : service.accounts.length === 0 ? (
							<Button size="sm" className="self-start" onClick={() => setOpen(service.id)}>
								{stale.length > 0 ? "Sign in again" : "Connect"}
							</Button>
						) : (
							<span className="flex flex-wrap items-center gap-2">
								<span className="text-meta text-ink-2">{service.accounts.join(", ")}</span>
								<span className="ml-auto flex items-center gap-2">
									{onManage === undefined ? null : (
										<Button variant="outline" size="xs" onClick={() => onManage(service.id)}>
											Details
										</Button>
									)}
									<Button
										variant={stale.length > 0 ? "outline" : "ghost"}
										size="xs"
										onClick={() => setOpen(service.id)}
									>
										{stale.length > 0 ? "Sign in again" : service.choices ? "Manage access" : "Add account"}
									</Button>
								</span>
							</span>
						)}
						{open === service.id && connect !== undefined ? connect(service, () => setOpen(undefined)) : null}
					</li>
				);
			})}
		</ul>
	);
}
