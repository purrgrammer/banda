/**
 * A row of the band: an agent or a group, its last message, when, and what it wants of the owner. Unread rows are
 * ink; an open ask reads as the ask itself; the face says whether the agent works, waits or rests.
 */
import { cn } from "@/lib/cn";
import { Face, FaceStack } from "./Face.tsx";
import { Inline } from "./inline.tsx";
import type { FaceState, RowView } from "./types.ts";

export type { RowView, Who } from "./types.ts";

export function Row({
	row,
	selected = false,
	collapsed = false,
	onSelect,
}: {
	row: RowView;
	selected?: boolean;
	/** The rail: the face alone, and a dot when something is unread. */
	collapsed?: boolean;
	onSelect?: () => void;
}) {
	const [first] = row.faces;
	const group = row.faces.length > 1;
	const unread = (row.unread ?? 0) > 0;
	const loud = unread || row.ask !== undefined;
	const state: FaceState = row.ask !== undefined ? "waiting" : (row.state ?? "idle");
	const face =
		group || first === undefined ? (
			<FaceStack faces={row.faces} name={row.name} waiting={state === "waiting"} />
		) : (
			<Face face={first.face} name={row.name} state={state} paused={row.paused ?? false} />
		);
	const label = [
		row.name,
		row.ask === undefined ? undefined : `waiting on you: ${row.ask}`,
		unread ? `${row.unread} unread` : undefined,
	]
		.filter(Boolean)
		.join(", ");
	if (collapsed)
		return (
			<button
				type="button"
				aria-label={label}
				aria-current={selected ? "page" : undefined}
				onClick={onSelect}
				className={cn(
					"relative flex size-12 items-center justify-center rounded-tile hover:bg-paper-3",
					selected && "bg-paper-3",
				)}
			>
				{face}
				{unread ? (
					<span
						aria-hidden="true"
						className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-ink ring-2 ring-paper-2"
					/>
				) : null}
			</button>
		);
	return (
		<button
			type="button"
			aria-label={label}
			aria-current={selected ? "page" : undefined}
			onClick={onSelect}
			className={cn(
				"flex h-[var(--row-height)] w-full items-center rounded-tile text-left",
				"gap-2 px-1",
				"transition-colors duration-[var(--duration-fast)] hover:bg-paper-3",
				selected && "bg-paper-3",
			)}
		>
			{face}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-baseline gap-2">
					<span className={cn("truncate text-ui text-ink", loud ? "font-semibold" : "font-medium")}>{row.name}</span>
					<span className={cn("ml-auto shrink-0 text-meta", unread ? "text-ink" : "text-ink-2")}>{row.time}</span>
				</span>
				<span className="flex items-center gap-2">
					<span className={cn("truncate text-ui", loud ? "text-ink" : "text-ink-2")}>
						{row.ask !== undefined ? (
							<span className="font-medium">Waiting: {row.ask}</span>
						) : (
							<>
								{row.by === undefined ? null : <span className={unread ? "text-ink-2" : undefined}>{row.by}: </span>}
								<Inline>{row.excerpt}</Inline>
							</>
						)}
					</span>
					{unread ? (
						<span className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-ink px-1.5 text-meta font-semibold text-paper">
							{row.unread}
						</span>
					) : null}
				</span>
			</span>
		</button>
	);
}
