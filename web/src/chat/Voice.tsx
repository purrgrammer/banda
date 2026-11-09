/**
 * A voice message, in either direction: the owner's, transcribed on their side and sent as words with the audio, on
 * their ink; or an agent's spoken reply. Play, and the words beneath: at rest all of them, while playing what was said
 * in full and the rest faint, each phrase a place to seek to.
 */
import { PauseIcon, PlayIcon } from "lucide-react";
import { Transcription, TranscriptionSegment } from "@/components/ai-elements/transcription";
import type { TranscriptionResult } from "@/components/ai-elements/types";
import { cn } from "@/lib/cn";
import { useMine } from "./Feed.tsx";

export function VoiceMessage({
	mine: told,
	duration,
	segments,
	at = 0,
	playing = false,
}: {
	mine?: boolean;
	duration: string;
	segments: TranscriptionResult["segments"];
	/** Seconds played so far. */
	at?: number;
	playing?: boolean;
}) {
	const inMine = useMine();
	const mine = told ?? inMine;
	const end = segments.at(-1)?.endSecond ?? 1;
	const now = playing || at > 0 ? at : end;
	const bars = [4, 7, 10, 6, 12, 8, 14, 9, 6, 11, 15, 10, 7, 13, 8, 5, 10, 12, 7, 4, 9, 13, 8, 6, 10, 7];
	return (
		<div
			className={cn(
				"flex w-80 max-w-full flex-col gap-2 rounded-bubble px-3 py-2.5",
				mine ? "bg-ink text-paper" : "border border-line-soft bg-paper text-ink",
			)}
		>
			<span className="flex items-center gap-2.5">
				<button
					type="button"
					aria-label={playing ? "Pause" : "Play"}
					className={cn(
						"flex size-8 shrink-0 items-center justify-center rounded-full",
						mine ? "bg-paper text-ink" : "bg-ink text-paper",
					)}
				>
					{playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="ml-0.5 size-3.5" />}
				</button>
				<span aria-hidden="true" className="flex h-6 flex-1 items-center gap-[2px]">
					{bars.map((h, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: a waveform, by position
							key={i}
							className={cn(
								"w-[3px] rounded-full bg-current",
								(i + 1) / bars.length > now / end || !playing ? "opacity-40" : undefined,
							)}
							style={{ height: h * 1.5 }}
						/>
					))}
				</span>
				<span className="shrink-0 text-meta tabular-nums opacity-70">{duration}</span>
			</span>
			<Transcription segments={segments} currentTime={now} className="gap-x-1 gap-y-0 text-ui">
				{(segment, index) => (
					<TranscriptionSegment
						key={`${segment.startSecond}-${segment.text}`}
						segment={segment}
						index={index}
						className={cn("text-ui text-current", segment.startSecond >= now && "opacity-45")}
					/>
				)}
			</Transcription>
		</div>
	);
}

/** Recording in the composer: how long, the level, cancel or send. */
export function Recording({ elapsed }: { elapsed: string }) {
	const bars = [3, 5, 8, 12, 9, 6, 11, 14, 10, 7, 5, 9, 13, 8, 6, 4, 7, 10, 12, 8];
	return (
		<span className="flex h-9 flex-1 items-center gap-3 px-1">
			<span className="size-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />
			<span className="text-ui font-medium text-ink tabular-nums">{elapsed}</span>
			<span aria-hidden="true" className="flex h-6 flex-1 items-center justify-end gap-[2px] overflow-hidden">
				{bars.map((h, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: a level meter, by position
						key={i}
						className="w-[3px] rounded-full bg-ink-2"
						style={{ height: h * 1.4 }}
					/>
				))}
			</span>
		</span>
	);
}
