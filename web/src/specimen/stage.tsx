/**
 * The specimen's stage: every section shows in light and dark side by side, or one of them, at desktop or phone width.
 * The theme resolves per frame (each frame sets its own `color-scheme`), so both show at once from the same tokens.
 */

import { createContext, type ReactNode, useContext } from "react";
import { cn } from "@/lib/cn";

export type Scheme = "both" | "light" | "dark";
export type Width = "desktop" | "phone";
export const StageContext = createContext<{ scheme: Scheme; width: Width }>({ scheme: "both", width: "desktop" });

/** One section: a title, a line saying what it is for, and its specimens in each frame. */
export function Section({
	id,
	title,
	note,
	bleed = false,
	wide = false,
	children,
}: {
	id: string;
	title: string;
	note?: string;
	/** A whole screen: no padding, a fixed height. */
	bleed?: boolean;
	/** Too wide for two frames side by side: light above dark. */
	wide?: boolean;
	children: ReactNode;
}) {
	const { scheme, width } = useContext(StageContext);
	const schemes: ("light" | "dark")[] = scheme === "both" ? ["light", "dark"] : [scheme];
	return (
		<section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-16 flex-col gap-3">
			<header className="flex flex-col gap-0.5">
				<h2 id={`${id}-title`} className="text-heading font-semibold text-ink">
					{title}
				</h2>
				{note === undefined ? null : <p className="max-w-[var(--measure)] text-ui text-ink-2">{note}</p>}
			</header>
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
	);
}

/** A labelled group of specimens inside a frame. */
export function Group({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
	return (
		<div className="flex flex-col gap-2.5">
			<p className="text-meta font-medium text-ink-2">{label}</p>
			<div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>
		</div>
	);
}

/** A floating header shown alone: the top of a chat, with a line of feed under it for the fade to fall on. */
export function HeaderStage({ children }: { children: ReactNode }) {
	return (
		<div className="relative h-36 overflow-hidden rounded-card border border-line-soft bg-paper">
			{children}
			<p className="absolute inset-x-0 top-24 mx-auto max-w-[36rem] px-4 text-body text-ink-2">
				One pull request needs you: CI went red overnight. I've pulled the failing checks and the diff that changed
				them.
			</p>
		</div>
	);
}
