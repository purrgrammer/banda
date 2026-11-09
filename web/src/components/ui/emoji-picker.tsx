/**
 * The emoji picker: frimousse's primitives (from its shadcn registry entry) in banda's tokens. Its data is vendored
 * and served by the daemon (`__EMOJIBASE__`, set by web/vite.config.ts), never fetched from a CDN: the root always sets
 * `emojibaseUrl`, and callers cannot override it. A failed load (offline on first open, a data shape frimousse does not
 * read) shows "Emoji list unavailable" instead of throwing.
 */

import {
	type EmojiPickerListCategoryHeaderProps,
	type EmojiPickerListEmojiProps,
	type EmojiPickerListRowProps,
	EmojiPicker as EmojiPickerPrimitive,
	type SkinTone,
} from "frimousse";
import { LoaderIcon, SearchIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/cn";

declare const __EMOJIBASE__: string;

/** Where the picker's data is served: the daemon's own origin, under the pinned emojibase-data's version. */
export const EMOJIBASE_URL: string = __EMOJIBASE__;

function EmojiPicker({
	className,
	...props
}: Omit<React.ComponentProps<typeof EmojiPickerPrimitive.Root>, "emojibaseUrl" | "resolveEmojiData" | "locale">) {
	return (
		<EmojiPickerPrimitive.Root
			className={cn("isolate flex h-full w-fit flex-col overflow-hidden bg-popover text-ink", className)}
			data-slot="emoji-picker"
			{...props}
			locale="en"
			emojibaseUrl={EMOJIBASE_URL}
		/>
	);
}

function EmojiPickerSearch({ className, ...props }: React.ComponentProps<typeof EmojiPickerPrimitive.Search>) {
	return (
		<div
			className={cn("flex h-10 min-w-0 flex-1 items-center gap-2 px-3", className)}
			data-slot="emoji-picker-search-wrapper"
		>
			<SearchIcon className="size-4 shrink-0 text-ink-2" />
			<EmojiPickerPrimitive.Search
				className="flex h-10 w-full bg-transparent py-3 text-ui outline-hidden placeholder:text-ink-2"
				data-slot="emoji-picker-search"
				placeholder="Search emoji"
				{...props}
			/>
		</div>
	);
}

function EmojiPickerRow({ children, ...props }: EmojiPickerListRowProps) {
	return (
		<div {...props} className="scroll-my-1 px-1" data-slot="emoji-picker-row">
			{children}
		</div>
	);
}

function EmojiPickerEmoji({ emoji, className, ...props }: EmojiPickerListEmojiProps) {
	return (
		<button
			{...props}
			className={cn(
				"flex size-9 items-center justify-center rounded-field text-[22px] leading-none data-[active]:bg-paper-3",
				className,
			)}
			data-slot="emoji-picker-emoji"
		>
			{emoji.emoji}
		</button>
	);
}

function EmojiPickerCategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
	return (
		<div
			{...props}
			className="bg-popover px-3 pt-3.5 pb-2 text-meta leading-none text-ink-2"
			data-slot="emoji-picker-category-header"
		>
			{category.label}
		</div>
	);
}

const UNAVAILABLE = "Emoji list unavailable";

function EmojiPickerContent({ className, ...props }: React.ComponentProps<typeof EmojiPickerPrimitive.Viewport>) {
	return (
		<EmojiPickerPrimitive.Viewport
			className={cn("relative flex-1 outline-hidden", className)}
			data-slot="emoji-picker-viewport"
			{...props}
		>
			<EmojiPickerPrimitive.Loading
				className="absolute inset-0 flex items-center justify-center text-ink-2"
				data-slot="emoji-picker-loading"
			>
				<LoaderIcon className="size-4 animate-spin" />
				<span className="sr-only">Loading emoji</span>
			</EmojiPickerPrimitive.Loading>
			<EmojiPickerPrimitive.Empty
				className="absolute inset-0 flex items-center justify-center text-ui text-ink-2"
				data-slot="emoji-picker-empty"
			>
				{({ search }) => (search === "" ? UNAVAILABLE : "No emoji found")}
			</EmojiPickerPrimitive.Empty>
			<EmojiPickerPrimitive.List
				className="pb-1 select-none"
				components={{ Row: EmojiPickerRow, Emoji: EmojiPickerEmoji, CategoryHeader: EmojiPickerCategoryHeader }}
				data-slot="emoji-picker-list"
			/>
		</EmojiPickerPrimitive.Viewport>
	);
}

/** Cycles the skin tone; `onSkinTone` hears each change, so the caller can remember it. */
function EmojiPickerSkinTone({ onSkinTone }: { onSkinTone?: (tone: SkinTone) => void }) {
	return (
		<>
			<EmojiPickerPrimitive.SkinToneSelector
				className="flex size-9 shrink-0 items-center justify-center rounded-field text-[22px] leading-none hover:bg-paper-3"
				aria-label="Skin tone"
				data-slot="emoji-picker-skin-tone"
			/>
			<EmojiPickerPrimitive.SkinTone>
				{({ skinTone }) => <Heard value={skinTone} onChange={onSkinTone} />}
			</EmojiPickerPrimitive.SkinTone>
		</>
	);
}

function Heard<T>({ value, onChange }: { value: T; onChange?: ((value: T) => void) | undefined }) {
	const first = React.useRef(true);
	React.useEffect(() => {
		if (first.current) first.current = false;
		else onChange?.(value);
	}, [value, onChange]);
	return null;
}

/** A load that failed (frimousse throws it to the nearest boundary) becomes the same quiet line as an empty list. */
class EmojiPickerBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed ? (
			<p className="flex flex-1 items-center justify-center p-6 text-ui text-ink-2" role="status">
				{UNAVAILABLE}
			</p>
		) : (
			this.props.children
		);
	}
}

/**
 * The whole picker: Recent (the caller's), search with the skin tone beside it, and the categories. Built to be
 * lazy-loaded, so frimousse and its data come only when the owner opens it.
 */
function EmojiPickerPanel({
	onPick,
	recent = [],
	skinTone = "none",
	onSkinTone,
	className,
}: {
	onPick: (emoji: string) => void;
	recent?: readonly string[];
	skinTone?: SkinTone;
	onSkinTone?: (tone: SkinTone) => void;
	className?: string;
}) {
	return (
		<div className={cn("flex min-h-0 flex-col", className)} data-slot="emoji-picker-panel">
			<EmojiPickerBoundary>
				<React.Suspense
					fallback={
						<div className="flex flex-1 items-center justify-center p-6 text-ink-2">
							<LoaderIcon className="size-4 animate-spin" />
						</div>
					}
				>
					<EmojiPicker
						className="min-h-0 w-full flex-1"
						columns={8}
						skinTone={skinTone}
						onEmojiSelect={({ emoji }) => onPick(emoji)}
					>
						<div className="flex items-center gap-1 border-b border-line-soft pr-1">
							<EmojiPickerSearch />
							<EmojiPickerSkinTone {...(onSkinTone === undefined ? {} : { onSkinTone })} />
						</div>
						{recent.length === 0 ? null : (
							<div className="flex flex-col gap-1 border-b border-line-soft px-2 py-2" data-slot="emoji-picker-recent">
								<p className="px-1 text-meta text-ink-2">Recent</p>
								<div className="flex flex-wrap">
									{recent.map((emoji) => (
										<button
											key={emoji}
											type="button"
											aria-label={emoji}
											className="flex size-9 items-center justify-center rounded-field text-[22px] leading-none hover:bg-paper-3"
											onClick={() => onPick(emoji)}
										>
											{emoji}
										</button>
									))}
								</div>
							</div>
						)}
						<EmojiPickerContent />
					</EmojiPicker>
				</React.Suspense>
			</EmojiPickerBoundary>
		</div>
	);
}

export {
	EmojiPicker,
	EmojiPickerBoundary,
	EmojiPickerContent,
	EmojiPickerPanel,
	EmojiPickerSearch,
	EmojiPickerSkinTone,
	UNAVAILABLE,
};
export default EmojiPickerPanel;
