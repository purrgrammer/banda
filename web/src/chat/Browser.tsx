/**
 * The agent's browser, enlarged for reading and take-over: the page as the agent sees it, with Take over, Give back
 * and Stop. Nothing is drawn over the page the agent reads; while the owner holds it, a bar says so. Closing hands
 * control back first; when hand-back cannot be confirmed, the view stays open with a retry. On the phone it turns
 * landscape, Give back pinned.
 */
import { MonitorIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { Line } from "./Line.tsx";

export type BrowserHold = "agent" | "owner" | "stuck";

export function BrowserWindow({
	agent,
	host,
	title,
	shot,
	hold = "agent",
	landscape = false,
	screen,
	why,
	onTakeOver,
	onGiveBack,
	onStop,
	onClose,
}: {
	agent: string;
	host: string;
	title: string;
	shot?: string | undefined;
	/** Who holds the page: the agent, the owner (took over), or a hand-back not yet confirmed. */
	hold?: BrowserHold;
	/** The phone turned sideways: the page fills it, Give back pinned. */
	landscape?: boolean;
	/** The live page, taking the owner's input while they hold it; a still `shot` otherwise. */
	screen?: ReactNode;
	/** Why the last control failed, in words. */
	why?: string | undefined;
	onTakeOver?: () => void;
	onGiveBack?: () => void;
	onStop?: () => void;
	onClose?: () => void;
}) {
	const owner = hold !== "agent";
	return (
		<div
			role="dialog"
			aria-label={`${agent}'s browser`}
			className={cn(
				"flex flex-col overflow-hidden bg-paper",
				landscape ? "h-full w-full" : "w-full rounded-tile border border-line shadow-[var(--shadow-composer)]",
			)}
		>
			<div
				className={cn("flex shrink-0 items-center gap-2 border-b border-line-soft px-3", landscape ? "h-10" : "h-12")}
			>
				<MonitorIcon aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-ui font-medium text-ink">{title}</span>
					{landscape ? null : <span className="truncate text-meta text-ink-2">{host}</span>}
				</span>
				{owner ? (
					<span className="flex items-center gap-1.5 text-meta font-medium text-ink">You're in control</span>
				) : (
					<span className="flex items-center gap-1.5 text-meta font-medium text-ink">
						<span className="size-1.5 animate-pulse rounded-full bg-alive" />
						{agent} is using it
					</span>
				)}
				{owner ? (
					<Button size="sm" className="ml-1" onClick={onGiveBack}>
						Give back
					</Button>
				) : (
					<Button variant="outline" size="sm" className="ml-1" onClick={onTakeOver}>
						Take over
					</Button>
				)}
				{landscape ? null : (
					<>
						<Button variant="ghost" size="sm" className="text-danger" onClick={onStop}>
							Stop
						</Button>
						<Button variant="ghost" size="icon-sm" aria-label="Close" className="text-ink-2" onClick={onClose}>
							<XIcon />
						</Button>
					</>
				)}
			</div>
			<div className={cn("relative min-h-0 bg-paper-2", landscape ? "flex-1" : "")}>
				{screen ?? (
					<img
						src={shot}
						alt={`${title}, as ${agent} sees it`}
						className={cn("block w-full object-cover object-top", landscape ? "h-full" : "aspect-[16/10]")}
					/>
				)}
			</div>
			{hold === "owner" && !landscape ? (
				<p className="border-t border-line-soft px-3 py-2 text-meta text-ink-2">
					{agent} waits while you use the page. Give it back when you are done.
				</p>
			) : null}
			{hold === "stuck" ? (
				<div className="border-t border-line-soft py-2">
					<Line
						tone="danger"
						action={{ label: "Try again", ...(onGiveBack === undefined ? {} : { onClick: onGiveBack }) }}
					>
						{why ?? `${agent} hasn't taken the page back yet`}
					</Line>
				</div>
			) : null}
		</div>
	);
}
