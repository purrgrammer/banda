/**
 * The chat's header: the agent's face and name, centred and floating over the feed, and under them its presence
 * (waiting on you, routines paused). It never says that an agent works, in words or in the face's motion: the feed's
 * working line does. It has no bar and no border: they sit on one small frosted shape, so the conversation scrolls
 * around and beneath it and keeps the screen. The face and the name open the panel; on the phone a back control leads
 * to the band. Its parent is `relative feed-scope`, and the feed's scroller `feed-scroll` and clears it with
 * `HEADER_CLEARANCE`.
 */
import { ChevronLeftIcon, PanelRightIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
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
	attention = false,
	delegated,
}: {
	name: string;
	faces: readonly (Who & { readonly state?: FaceState | undefined })[];
	/** Its presence in words, when "waiting" alone does not say it: "A coding session waits on you". */
	doing?: string | undefined;
	state?: FaceState | undefined;
	attention?: boolean;
	delegated?: ReactNode;
	paused?: boolean;
	phone?: boolean;
	panelOpen?: boolean;
	onBack?: () => void;
	/** The name opens the panel (a sheet on the phone); the button at the right toggles it. */
	onPanel?: () => void;
	/** The presence line opens what it waits on, not the panel. */
	onActivity?: (() => void) | undefined;
}) {
	// work is said in the feed, by the working line: here a working face rests, as an idle one does
	const rest = (each: FaceState | undefined): FaceState => (each === "working" || each === undefined ? "idle" : each);
	const shown = rest(state);
	const resting = faces.map((each) => ({ ...each, state: rest(each.state) }));
	const [first] = resting;
	const line = paused ? "Routines paused" : shown === "waiting" ? (doing ?? "Waiting on you") : undefined;
	const face =
		resting.length > 1 || first === undefined ? (
			<FaceStack faces={resting} name={name} size="panel" waiting={attention || shown === "waiting"} />
		) : (
			<Face face={first.face} name={name} size="panel" state={attention ? "waiting" : shown} paused={paused} />
		);
	return (
		<header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-2.5 pt-2">
			{phone ? (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Back to the band"
					className="pointer-events-auto absolute top-2.5 left-1.5"
					onClick={onBack}
				>
					<ChevronLeftIcon className="size-5" />
				</Button>
			) : null}
			<div className="pointer-events-auto relative isolate flex max-w-[min(20rem,calc(100%-6rem))] min-w-0 flex-col items-center">
				<Contour name={name} line={line} />
				<button
					type="button"
					className="flex min-w-0 max-w-full flex-col items-center text-ink outline-none focus-visible:[&>span:first-child]:ring-2 focus-visible:[&>span:first-child]:ring-line rounded-full"
					aria-label={`${name}: open its panel`}
					onClick={onPanel}
				>
					<span className="inline-flex rounded-full p-2">{face}</span>
					<span className={cn("max-w-full truncate px-3 text-ui font-semibold", line === undefined && "pb-1.5")}>
						{name}
					</span>
				</button>
				{line === undefined ? null : (
					<button
						type="button"
						onClick={onActivity}
						disabled={onActivity === undefined || paused}
						aria-label={onActivity === undefined || paused ? undefined : `Activity: ${line}`}
						className="max-w-full min-w-0 truncate px-3 pb-1.5 text-center text-meta text-ink-2 enabled:hover:text-ink"
					>
						{line}
					</button>
				)}
			</div>
			<div className="pointer-events-auto absolute top-2.5 right-1.5 flex items-center gap-1">
				{delegated}
				{phone || onPanel === undefined ? null : (
					<Button
						variant="ghost"
						size="icon-sm"
						className={cn("text-ink-2", panelOpen && "bg-paper-3 text-ink")}
						aria-label={panelOpen ? "Hide the panel" : "Show the panel"}
						aria-pressed={panelOpen}
						onClick={onPanel}
					>
						<PanelRightIcon />
					</Button>
				)}
			</div>
		</header>
	);
}

/**
 * The shape behind the face and the name, following their outline: a circle round the face and a pill round the
 * words, melted into one where they meet (blurred a little, then cut at half its alpha), in the chat's own paper with
 * no line round it. It lifts with a soft shadow only once the feed scrolls under it (`header-lift`). It lays out the
 * same boxes as what it sits behind, words hidden, so it fits any name without measuring.
 */
function Contour({ name, line }: { name: string; line: string | undefined }) {
	const id = useId();
	return (
		<div aria-hidden="true" className="header-lift pointer-events-none absolute inset-0 -z-10">
			<div className="flex h-full flex-col items-center" style={{ filter: `url(#${CSS.escape(id)})` }}>
				<svg width="0" height="0" className="absolute" aria-hidden="true">
					<filter id={id} x="-20%" y="-20%" width="140%" height="140%">
						<feGaussianBlur in="SourceGraphic" stdDeviation="3" />
						<feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -12" />
					</filter>
				</svg>
				<span className="size-20 shrink-0 rounded-full bg-paper" />
				<span className="-mt-2 flex max-w-full flex-col items-center rounded-full bg-paper px-3 pt-2 pb-1.5 text-transparent select-none">
					<span className="max-w-full truncate text-ui font-semibold">{name}</span>
					{line === undefined ? null : <span className="max-w-full truncate text-meta">{line}</span>}
				</span>
			</div>
		</div>
	);
}

/** How far the feed starts below the top, so its first message clears the floating header. */
export const HEADER_CLEARANCE = "pt-32";
