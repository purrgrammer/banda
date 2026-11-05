/**
 * The chat's header: the agent's face and name and, under it, what it does now ("Using its browser…", "Thinking…";
 * in a group, "Mara and Sancho are working…"), shimmering while it works, or its presence (waiting on you, routines
 * paused). Said here once: the feed has no working line. The name opens the panel; on the phone a back control leads
 * to the band.
 */
import { ChevronLeftIcon, PanelRightIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { Face, FaceStack, type FaceState } from "./Face.tsx";
import type { Who } from "./Row.tsx";

export function Header({
	name,
	faces,
	doing,
	state = "idle",
	paused = false,
	phone = false,
	panelOpen = false,
	onBack,
	onPanel,
	onActivity,
}: {
	name: string;
	faces: readonly (Who & { readonly state?: FaceState | undefined })[];
	/** What it does now, or its presence, in words, when the state alone does not say it: "Using its browser…". */
	doing?: string | undefined;
	state?: FaceState | undefined;
	paused?: boolean;
	phone?: boolean;
	panelOpen?: boolean;
	onBack?: () => void;
	/** The name opens the panel (a sheet on the phone); the button at the right toggles it. */
	onPanel?: () => void;
	/** The status opens the current work's activity, not the panel. */
	onActivity?: (() => void) | undefined;
}) {
	const [first] = faces;
	const line = paused
		? "Routines paused"
		: (doing ?? (state === "working" ? "Working…" : state === "waiting" ? "Waiting on you" : undefined));
	return (
		<header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line-soft bg-paper px-2.5">
			{phone ? (
				<Button variant="ghost" size="icon-sm" aria-label="Back to the band" className="-ml-1" onClick={onBack}>
					<ChevronLeftIcon className="size-5" />
				</Button>
			) : null}
			<div className="flex min-w-0 items-center gap-2.5 px-1.5 py-1">
				{faces.length > 1 || first === undefined ? (
					<FaceStack faces={faces} name={name} size="message" waiting={state === "waiting"} />
				) : (
					<Face face={first.face} name={name} size="message" state={state} paused={paused} />
				)}
				<div className="flex min-w-0 flex-col">
					<button
						type="button"
						className="truncate rounded-field text-left text-heading font-semibold text-ink hover:bg-paper-3"
						aria-label={`${name}: open its panel`}
						onClick={onPanel}
					>
						{name}
					</button>
					{line === undefined ? null : (
						<button
							type="button"
							onClick={onActivity}
							disabled={onActivity === undefined || paused}
							aria-label={onActivity === undefined || paused ? undefined : `Activity: ${line}`}
							className="min-w-0 truncate rounded-field text-left text-meta text-ink-2 enabled:hover:text-ink"
						>
							{state === "working" && !paused ? (
								<Shimmer as="span" aria-live="polite" duration={2.4}>
									{line}
								</Shimmer>
							) : (
								line
							)}
						</button>
					)}
				</div>
			</div>
			{phone || onPanel === undefined ? null : (
				<Button
					variant="ghost"
					size="icon-sm"
					className={cn("ml-auto text-ink-2", panelOpen && "bg-paper-3 text-ink")}
					aria-label={panelOpen ? "Hide the panel" : "Show the panel"}
					aria-pressed={panelOpen}
					onClick={onPanel}
				>
					<PanelRightIcon />
				</Button>
			)}
		</header>
	);
}

/** What the header says while a group works: who, in words. */
export function workingWords(names: readonly string[]): string | undefined {
	if (names.length === 0) return undefined;
	if (names.length === 1) return `${names[0]} is working…`;
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are working…`;
}
