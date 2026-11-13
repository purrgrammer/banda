/**
 * The specimen's stage: every section shows in light and dark side by side, or one of them, at desktop or phone width.
 * The theme resolves per frame (each frame sets its own `color-scheme`), so both show at once from the same tokens.
 * A section's title, status and sources come from the registry; a section not registered there refuses to render.
 */

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { type Entry, STATUS_WORDS, sectionOf } from "./registry.ts";
import { hrefOf, type Scheme, type Width } from "./url.ts";

export type { Scheme, Width } from "./url.ts";

export const StageContext = createContext<{
	scheme: Scheme;
	width: Width;
	/** Set, only this section renders: the rest return nothing. */
	only?: string;
}>({ scheme: "both", width: "desktop" });

/** The scheme of the frame a specimen is drawn in: one drawn in both is two of it, and each keeps what is its own. */
export const FrameContext = createContext<"light" | "dark">("light");

/** The registered section, or an error naming the file to add it to. */
function entryOf(id: string): Entry {
	const entry = sectionOf(id);
	if (entry === undefined)
		throw new Error(`The specimen section "${id}" is not registered: add it to web/src/specimen/registry.ts`);
	return entry;
}

/**
 * How far below the view a section's contents mount. Below only: a jump to a section leaves those above it as they
 * were, so it stays where it landed.
 */
const AHEAD = "0px 0px 800px 0px";

/** Whether a section's contents have come near the view, once and for good. With no observer (the server), all have. */
function useNear(element: HTMLElement | null): boolean {
	const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
	useEffect(() => {
		if (near || element === null) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setNear(true);
			},
			{ root: element.closest("main"), rootMargin: AHEAD },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element, near]);
	return near;
}

/** One section: its title and badges from the registry, a line saying what it is for, and its specimens in each frame. */
export function Section({
	id,
	note,
	bleed = false,
	wide = false,
	children,
}: {
	id: string;
	note?: string;
	/** A whole screen: no padding, a fixed height. */
	bleed?: boolean;
	/** Too wide for two frames side by side: light above dark. */
	wide?: boolean;
	children: ReactNode;
}) {
	const entry = entryOf(id);
	const { scheme, width, only } = useContext(StageContext);
	const [element, setElement] = useState<HTMLElement | null>(null);
	const near = useNear(element);
	if (only !== undefined && only !== id) return null;
	const schemes: ("light" | "dark")[] = scheme === "both" ? ["light", "dark"] : [scheme];
	return (
		<section ref={setElement} id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
			<header className="flex flex-col gap-1">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<h2 id={`${id}-title`} className="text-heading font-semibold text-ink">
						<a href={hrefOf({ section: id, scheme, width })} className="hover:underline">
							{entry.title}
						</a>
					</h2>
					<Badge variant="outline">{STATUS_WORDS[entry.status]}</Badge>
					{entry.only === undefined ? null : (
						<Badge variant="outline">{entry.only === "phone" ? "Phone only" : "Desktop only"}</Badge>
					)}
					{only === undefined ? (
						<a
							href={hrefOf({ section: id, scheme, width, only: true })}
							className="text-meta text-ink-2 hover:text-ink"
							title="This section alone, with no header or contents"
						>
							Alone
						</a>
					) : null}
				</div>
				{note === undefined ? null : <p className="max-w-[var(--measure)] text-ui text-ink-2">{note}</p>}
				<p className="flex flex-wrap gap-x-3 font-code text-meta text-ink-2">
					{entry.sources.map((source) => (
						<span key={source}>{source}</span>
					))}
				</p>
			</header>
			{near || only === id ? (
				<div
					className={cn(
						"grid min-w-0 grid-cols-1 gap-3",
						schemes.length === 2 &&
							!(wide && width === "desktop") &&
							(width === "desktop" ? "xl:grid-cols-2" : "md:grid-cols-[repeat(2,390px)]"),
					)}
				>
					{schemes.map((one) => (
						<Frame key={one} scheme={one} width={width} bleed={bleed}>
							{children}
						</Frame>
					))}
				</div>
			) : (
				<div className="h-96 rounded-tile border border-line-soft bg-paper" />
			)}
		</section>
	);
}

function Frame({
	scheme,
	width,
	bleed,
	children,
}: {
	scheme: "light" | "dark";
	width: Width;
	bleed: boolean;
	children: ReactNode;
}) {
	return (
		<FrameContext.Provider value={scheme}>
			<div
				style={{ colorScheme: scheme }}
				data-scheme={scheme}
				className={cn(
					"overflow-hidden rounded-tile border border-line bg-paper text-ink",
					width === "phone" && "w-[390px] max-w-full",
				)}
			>
				{bleed ? (
					<div className={cn("flex", width === "phone" ? "h-[780px]" : "h-[720px]")}>{children}</div>
				) : (
					<div className="flex flex-col gap-6 p-5">{children}</div>
				)}
			</div>
		</FrameContext.Provider>
	);
}

/** A labelled group of specimens inside a frame, in a row that wraps. */
export function Group({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
	return (
		<div className="flex flex-col gap-2.5">
			<p className="text-meta font-medium text-ink-2">{label}</p>
			<div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>
		</div>
	);
}

/** One labelled specimen in a column: the label above, the thing below. */
export function Labelled({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<p className="text-meta font-medium text-ink-2">{label}</p>
			{children}
		</div>
	);
}

/** A chat header with a line of feed beneath it. */
export function HeaderStage({ children }: { children: ReactNode }) {
	return (
		<div className="w-full overflow-hidden rounded-card border border-line-soft bg-paper">
			{children}
			<p className="mx-auto max-w-[36rem] px-4 py-4 text-body text-ink-2">
				One pull request needs you: CI went red overnight. I've pulled the failing checks and the diff that changed
				them.
			</p>
		</div>
	);
}
