/**
 * Loading and empty states: what shows before the daemon answers, and when there is nothing to show yet. A skeleton
 * has the shape of what is coming, so nothing jumps when it lands; it pulses slowly and stills under reduced motion.
 * An empty state says what will be here and how it gets here, in one or two plain lines.
 */
import { CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { Tile } from "./Cards.tsx";
import { FaceStack } from "./Face.tsx";
import type { Who } from "./Row.tsx";

const Bone = ({ className }: { className?: string }) => (
	<Skeleton className={cn("rounded-full bg-paper-3 motion-reduce:animate-none", className)} />
);

/** The band before its rows arrive. */
export function RowsLoading({ count = 4 }: { count?: number }) {
	return (
		<div role="status" aria-label="Loading your band" className="flex flex-col gap-0.5 px-2">
			{Array.from({ length: count }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: placeholders, nothing to key them by
				<div key={i} className="flex h-[var(--row-height)] items-center gap-3 px-2">
					<Bone className="size-10" />
					<span className="flex flex-1 flex-col gap-2">
						<Bone className="h-3 w-20" />
						<Bone className={cn("h-2.5", i % 2 === 0 ? "w-36" : "w-28")} />
					</span>
				</div>
			))}
		</div>
	);
}

/** A chat before its messages arrive: the shape of a few runs, both sides. */
export function ChatLoading() {
	return (
		<div role="status" aria-label="Loading the chat" className="flex flex-col gap-6 py-2">
			<div className="flex gap-2.5">
				<Bone className="size-7" />
				<span className="flex flex-col gap-2">
					<Bone className="h-3 w-16" />
					<Skeleton className="h-16 w-72 rounded-bubble bg-paper-3 motion-reduce:animate-none" />
				</span>
			</div>
			<Skeleton className="h-10 w-56 self-end rounded-bubble bg-paper-3 motion-reduce:animate-none" />
			<div className="flex gap-2.5">
				<Bone className="size-7" />
				<span className="flex flex-col gap-2">
					<Bone className="h-3 w-16" />
					<Skeleton className="h-10 w-80 rounded-bubble bg-paper-3 motion-reduce:animate-none" />
					<Skeleton className="h-24 w-64 rounded-tile bg-paper-3 motion-reduce:animate-none" />
				</span>
			</div>
		</div>
	);
}

/** The panel before the agent's file is read. */
export function PanelLoading() {
	return (
		<div role="status" aria-label="Loading" className="flex flex-col">
			<div className="flex flex-col items-center gap-2.5 px-4 pt-6 pb-4">
				<Bone className="size-16" />
				<Bone className="mt-1 h-4 w-24" />
				<Bone className="h-2.5 w-32" />
			</div>
			<div className="flex gap-4 border-b border-line-soft px-4 pb-3">
				<Bone className="h-3 w-14" />
				<Bone className="h-3 w-18" />
				<Bone className="h-3 w-12" />
				<Bone className="h-3 w-12" />
			</div>
			<div className="flex flex-col gap-4 p-4">
				{[0, 1, 2].map((i) => (
					<span key={i} className="flex flex-col gap-2">
						<Bone className="h-3 w-24" />
						<Bone className="h-2.5 w-44" />
					</span>
				))}
			</div>
		</div>
	);
}

/** An object while the daemon reads it: the card's frame, so the chat does not jump. */
export function ObjectLoading() {
	return (
		<Tile className="flex flex-col gap-3 p-3.5">
			<span role="status" aria-label="Reading from GitHub" className="flex flex-col gap-3">
				<Bone className="h-2.5 w-40" />
				<Bone className="h-3.5 w-3/4" />
				<span className="flex gap-2">
					<Bone className="h-5 w-16" />
					<Bone className="h-5 w-28" />
				</span>
			</span>
		</Tile>
	);
}

/** An object the daemon could not read: who, what and the fix; the agent's words around it still stand. */
export function ObjectUnavailable({
	what,
	why,
	fix,
	onFix,
	busy,
}: {
	what: string;
	why: string;
	fix?: string | undefined;
	onFix?: () => void;
	busy?: boolean;
}) {
	return (
		<Tile className="flex items-start gap-3 p-3.5">
			<CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-2" />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-ui font-medium text-ink">{what}</span>
				<span className="text-meta text-ink-2">{why}</span>
			</span>
			{fix === undefined ? null : (
				<Button variant="outline" size="xs" onClick={onFix} disabled={busy}>
					{fix}
				</Button>
			)}
		</Tile>
	);
}

/** A file whose preview is still being drawn: its card, the glimpse a skeleton. */
export function FileLoading({ name, size }: { name: string; size: string }) {
	return (
		<div className="flex w-72 max-w-full flex-col overflow-hidden rounded-tile border border-line-soft bg-paper">
			<Skeleton className="h-36 rounded-none bg-paper-3 motion-reduce:animate-none" />
			<span className="flex flex-col px-3 py-2.5">
				<span className="truncate text-ui font-medium text-ink">{name}</span>
				<span className="text-meta text-ink-2">Preparing a preview · {size}</span>
			</span>
		</div>
	);
}

/** A group with nothing in it yet: its faces, its name, and how @ works. */
export function GroupEmpty({ name, faces }: { name: string; faces: readonly Who[] }) {
	return (
		<div className="flex flex-col items-center gap-2 py-10 text-center">
			<FaceStack faces={faces} name={name} size="panel" />
			<p className="mt-2 text-heading font-semibold text-ink">{name}</p>
			<p className="max-w-xs text-ui text-ink-2">
				A message asks everyone. Start one with @ and a name to ask just that one.
			</p>
		</div>
	);
}
