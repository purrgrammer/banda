import { ChevronLeftIcon, ChevronRightIcon, PanelRightIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { AvatarFace } from "../../../src/core/avatar-face.ts";
import { Face, FaceStack, type FaceState } from "./Face.tsx";
import type { Who } from "./types.ts";

export type PaneParent = { readonly title: string; readonly href: string };

/** The title bar shared by chats and settings pages. */
export function PaneHeader({
	title,
	icon,
	parent,
	onTitle,
	navigation,
	phone = false,
	trailing,
	detail,
}: {
	title: string;
	icon: ReactNode;
	parent?: PaneParent | undefined;
	onTitle?: (() => void) | undefined;
	navigation?: ReactNode;
	phone?: boolean;
	trailing?: ReactNode;
	detail?: ReactNode;
}) {
	const heading =
		onTitle === undefined ? (
			<h1 data-page-title="" tabIndex={-1} className="truncate text-ui font-semibold text-ink focus:outline-none">
				{title}
			</h1>
		) : (
			<h1 aria-label={title} className="text-ui font-semibold text-ink">
				<button
					type="button"
					aria-label={`${title}: open its panel`}
					className="block max-w-full truncate rounded-field text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
					onClick={onTitle}
				>
					{title}
				</button>
			</h1>
		);
	return (
		<header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line-soft bg-paper px-2.5">
			{phone ? navigation : null}
			<span
				data-pane-icon=""
				aria-hidden="true"
				className="inline-flex size-6 shrink-0 items-center justify-center text-ink-2 [&>svg]:size-4"
			>
				{icon}
			</span>
			<div className="min-w-0 flex-1">
				{parent === undefined ? (
					heading
				) : (
					<nav aria-label="Breadcrumb">
						<ol className="flex min-w-0 items-center gap-1.5">
							<li className="min-w-0 max-w-[40%]">
								<a
									href={parent.href}
									className="block truncate rounded-field text-ui text-ink-2 hover:text-ink hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-focus"
								>
									{parent.title}
								</a>
							</li>
							<li aria-current="page" className="flex min-w-0 items-center gap-1.5">
								<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 text-ink-2 rtl:rotate-180" />
								{heading}
							</li>
						</ol>
					</nav>
				)}
				{detail}
			</div>
			{trailing}
			{phone ? null : navigation}
		</header>
	);
}

/** The chat's name opens its panel. Waiting and delegated activity have their own controls. */
export function Header({
	name,
	face,
	faces = [],
	doing,
	state,
	paused = false,
	phone = false,
	panelOpen = false,
	onBack,
	onPanel,
	onActivity,
	delegated,
}: {
	name: string;
	face?: AvatarFace | undefined;
	faces?: readonly Who[] | undefined;
	doing?: string | undefined;
	state?: FaceState | undefined;
	paused?: boolean;
	delegated?: ReactNode;
	phone?: boolean;
	panelOpen?: boolean;
	onBack?: () => void;
	onPanel?: () => void;
	onActivity?: (() => void) | undefined;
}) {
	const line = paused ? "Routines paused" : state === "waiting" ? (doing ?? "Waiting on you") : undefined;
	const first = face ?? faces[0]?.face;
	const icon =
		faces.length > 1 ? (
			<FaceStack faces={faces} name={name} size="mention" />
		) : first === undefined ? (
			<UsersIcon />
		) : (
			<Face face={first} name={name} size="mention" />
		);
	return (
		<PaneHeader
			title={name}
			icon={icon}
			onTitle={onPanel}
			phone={phone}
			navigation={
				phone ? (
					<Button variant="ghost" size="icon-sm" aria-label="Back to the band" className="text-ink-2" onClick={onBack}>
						<ChevronLeftIcon className="size-5" />
					</Button>
				) : null
			}
			detail={
				line === undefined ? null : onActivity === undefined || paused ? (
					<p className="truncate text-meta text-ink-2">{line}</p>
				) : (
					<button
						type="button"
						onClick={onActivity}
						aria-label={`Activity: ${line}`}
						className="block max-w-full truncate rounded-field text-left text-meta text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ring"
					>
						{line}
					</button>
				)
			}
			trailing={
				<div className="flex shrink-0 items-center gap-1 empty:hidden">
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
			}
		/>
	);
}
