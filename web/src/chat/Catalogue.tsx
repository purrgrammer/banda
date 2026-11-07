/**
 * Connections: what the band can work with, one tile per service. Reached from the band's foot and from Settings, so
 * the owner can connect before any agent needs it. A service shows its accounts once signed in; one not shipped yet
 * says so, and is not a button. What waits on the owner (an account to sign in to again, a server not reached) shows on
 * its tile with the band menu's dot.
 */
import {
	CalendarIcon,
	type LucideIcon,
	MailIcon,
	MessageSquareIcon,
	NotebookIcon,
	SquareKanbanIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { GitHubMark } from "./Object.tsx";

export type Service = {
	readonly id: string;
	readonly name: string;
	/** What it lets the band do, in a few words. */
	readonly does: string;
	/** Accounts signed in to it; undefined when the service is not shipped yet. */
	readonly accounts?: readonly string[] | undefined;
	readonly managed?: boolean;
	/** Accounts whose sign-in no longer fits the connection: the owner signs in again. */
	readonly stale?: readonly string[] | undefined;
	/** Why the connection is not reached, in words. */
	readonly problem?: string | undefined;
};

const ICONS: Record<string, LucideIcon> = {
	gmail: MailIcon,
	calendar: CalendarIcon,
	slack: MessageSquareIcon,
	linear: SquareKanbanIcon,
	notion: NotebookIcon,
};

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
	/** The connect card for a service, opened in its tile by Connect or Add account. */
	connect?: ((service: Service, close: () => void) => ReactNode) | undefined;
}) {
	const [open, setOpen] = useState<string | undefined>(undefined);
	const toggle = (id: string) => setOpen(open === id ? undefined : id);
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
				const Icon = ICONS[service.id];
				const stale = soon ? [] : (service.stale ?? []);
				const problem = soon ? undefined : service.problem;
				return (
					<li
						key={service.id}
						className={cn("flex flex-col gap-3 rounded-tile border border-line-soft p-4", soon && "bg-paper-2")}
					>
						<span className="flex items-center gap-3">
							<span className="flex size-10 shrink-0 items-center justify-center rounded-field bg-paper-3">
								{service.id === "github" ? (
									<GitHubMark className="size-5" />
								) : Icon === undefined ? null : (
									<Icon aria-hidden="true" className="size-5 text-ink-2" />
								)}
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
							open === service.id && connect !== undefined ? null : (
								<Button size="sm" className="self-start" onClick={() => toggle(service.id)}>
									{stale.length > 0 ? "Sign in again" : "Connect"}
								</Button>
							)
						) : (
							<span className="flex flex-wrap items-center gap-2">
								<span className="text-meta text-ink-2">{service.accounts.join(", ")}</span>
								<Button
									variant={stale.length > 0 ? "outline" : "ghost"}
									size="xs"
									className="ml-auto"
									onClick={() => toggle(service.id)}
								>
									{stale.length > 0 ? "Sign in again" : "Add account"}
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
