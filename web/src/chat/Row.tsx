/**
 * A row of the band: an agent or a group, its last message, when, and what it wants of the owner. Unread rows are
 * ink; an open ask reads as the ask itself; the face says whether the agent works, waits or rests.
 */
import { PinIcon, PinOffIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Face, FaceStack } from "./Face.tsx";
import { Inline } from "./inline.tsx";
import type { FaceState, RowView } from "./types.ts";

export type { RowView, Who } from "./types.ts";

export function Row({
	row,
	selected = false,
	collapsed = false,
	revealed = false,
	onSelect,
	onPin,
	onHold,
}: {
	row: RowView;
	selected?: boolean;
	/** The rail: the face alone, and a dot when something is unread. */
	collapsed?: boolean;
	/** Show the pin as a pointer over the row would (the specimen). */
	revealed?: boolean;
	onSelect?: () => void;
	/** The pin over the row's time, on hover or focus: it goes up among the pinned. */
	onPin?: (() => void) | undefined;
	/** A long press on the phone: what can be done with the row. */
	onHold?: (() => void) | undefined;
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
		<div className="group/row relative">
			<button
				type="button"
				aria-label={label}
				aria-current={selected ? "page" : undefined}
				onClick={onSelect}
				onContextMenu={held(onHold)}
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
						<span
							className={cn(
								"ml-auto shrink-0 text-meta",
								unread ? "text-ink" : "text-ink-2",
								onPin !== undefined && "group-focus-within/row:invisible group-hover/row:invisible",
								onPin !== undefined && revealed && "invisible",
							)}
						>
							{row.time}
						</span>
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
			{onPin === undefined ? null : (
				<button
					type="button"
					aria-label={`Pin ${row.name}`}
					title="Pin to the top"
					onClick={onPin}
					className={cn(
						"absolute top-1.5 right-1 inline-flex size-6 items-center justify-center rounded-field text-ink-2 hover:bg-paper-2 hover:text-ink",
						"opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
						revealed && "opacity-100",
					)}
				>
					<PinIcon className="size-3.5" />
				</button>
			)}
		</div>
	);
}

/** A long press (the phone's context menu) handed to `on`, the browser's own menu kept away; nothing when there is none. */
function held(on: (() => void) | undefined) {
	return on === undefined
		? undefined
		: (event: { preventDefault: () => void }) => {
				event.preventDefault();
				on();
			};
}

/**
 * A pinned agent or group at the top of the band: its face large over its name, every tile the same size. It has no
 * row in the list below; what it wants of the owner rides on the face as a dot: waiting at its foot, unread at its top.
 */
export function PinnedTile({
	row,
	selected = false,
	revealed = false,
	onSelect,
	onUnpin,
	onHold,
}: {
	row: RowView;
	selected?: boolean;
	/** Show the unpin as a pointer over the tile would (the specimen). */
	revealed?: boolean;
	onSelect?: () => void;
	/** The unpin at the tile's corner, on hover or focus: back among the rows. */
	onUnpin?: (() => void) | undefined;
	/** A long press on the phone: what can be done with it. */
	onHold?: (() => void) | undefined;
}) {
	const [first] = row.faces;
	const unread = (row.unread ?? 0) > 0;
	const state: FaceState = row.ask !== undefined ? "waiting" : (row.state ?? "idle");
	const label = [
		row.name,
		"pinned",
		row.ask === undefined ? undefined : `waiting on you: ${row.ask}`,
		unread ? `${row.unread} unread` : undefined,
	]
		.filter(Boolean)
		.join(", ");
	return (
		<div className="group/tile relative flex w-full snap-start">
			<button
				type="button"
				aria-label={label}
				aria-current={selected ? "page" : undefined}
				onClick={onSelect}
				onContextMenu={held(onHold)}
				className={cn(
					"flex w-full flex-col items-center gap-1 rounded-tile px-1 pt-2 pb-1.5",
					"transition-colors duration-[var(--duration-fast)] hover:bg-paper-3",
					selected && "bg-paper-3",
				)}
			>
				<span className="relative inline-flex">
					{row.faces.length > 1 || first === undefined ? (
						<FaceStack faces={row.faces} name={row.name} size="panel" waiting={state === "waiting"} />
					) : (
						<Face face={first.face} name={row.name} size="panel" state={state} paused={row.paused ?? false} />
					)}
					{unread ? (
						<span
							aria-hidden="true"
							className="absolute top-0.5 right-0.5 size-3 rounded-full bg-ink ring-2 ring-paper-2"
						/>
					) : null}
				</span>
				<span
					className={cn(
						"max-w-full truncate text-meta",
						unread || row.ask !== undefined ? "font-semibold text-ink" : "font-medium text-ink-2",
					)}
				>
					{row.name}
				</span>
			</button>
			{onUnpin === undefined ? null : (
				<button
					type="button"
					aria-label={`Unpin ${row.name}`}
					title="Unpin"
					onClick={onUnpin}
					className={cn(
						"absolute top-1 left-1 inline-flex size-6 items-center justify-center rounded-full bg-paper text-ink-2 shadow-composer hover:text-ink",
						"opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100",
						revealed && "opacity-100",
					)}
				>
					<PinOffIcon className="size-3.5" />
				</button>
			)}
		</div>
	);
}

/**
 * What a long press on the phone offers for a row or a tile: its face and name, and pinning it to the top or letting
 * it go back among the rows.
 */
export function RowActions({
	row,
	pinned,
	onPin,
}: {
	row: RowView;
	pinned: boolean;
	onPin?: ((pinned: boolean) => void) | undefined;
}) {
	const [first] = row.faces;
	return (
		<div className="flex flex-col gap-1 px-2 pt-3 pb-2">
			<div className="flex items-center gap-3 px-2 pb-2">
				{row.faces.length > 1 || first === undefined ? (
					<FaceStack faces={row.faces} name={row.name} />
				) : (
					<Face face={first.face} name={row.name} />
				)}
				<span className="truncate text-heading font-semibold text-ink">{row.name}</span>
			</div>
			<button
				type="button"
				onClick={() => onPin?.(!pinned)}
				className="flex h-12 items-center gap-3 rounded-tile px-3 text-left text-body text-ink hover:bg-paper-3 active:bg-paper-3"
			>
				{pinned ? <PinOffIcon className="size-5 text-ink-2" /> : <PinIcon className="size-5 text-ink-2" />}
				{pinned ? "Unpin" : "Pin to the top"}
			</button>
		</div>
	);
}
