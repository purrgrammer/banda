/** An agent's accepted shape and colour. Motion lives in the face, never an orbit or working icon. */
import { UsersIcon } from "lucide-react";
import type { AvatarMotion } from "open-bot-avatar";
import { cn } from "@/lib/cn";
import type { AvatarFace } from "../../../src/core/avatar-face.ts";
import { AvatarRenderer } from "../avatar/Renderer.tsx";
import type { FaceState, Who } from "./types.ts";

export type { FaceState } from "./types.ts";

export const FACE_SIZE = { mention: 20, message: 28, row: 40, panel: 64, hero: 96 } as const;
/** A size in pixels, or `text`: as tall as the words it sits among, whatever their size (a mention in a message). */
export type FaceSize = keyof typeof FACE_SIZE | "text";

const moodOf = (state: FaceState | undefined): AvatarMotion =>
	state === "working" ? "thinking" : state === "happy" ? "happy" : "idle";

export function Face({
	face,
	name,
	size = "row",
	state = "idle",
	paused = false,
	className,
}: {
	face: AvatarFace;
	name: string;
	size?: FaceSize;
	state?: FaceState;
	paused?: boolean;
	className?: string;
}) {
	const text = size === "text";
	const words = [
		name,
		state === "working" ? "working" : state === "waiting" ? "waiting on you" : "",
		paused ? "routines paused" : "",
	]
		.filter(Boolean)
		.join(", ");
	return (
		<span
			role="img"
			aria-label={words}
			data-state={state}
			className={cn(
				"relative inline-flex shrink-0",
				// sized from the text, and centred on its capitals: an inline block with nothing in its lines has its
				// baseline at its bottom edge, so lowering that edge by half of what the face exceeds the capitals by centres it
				text && "inline-block size-[1.1em] align-[calc((1cap_-_1.1em)/2)]",
				className,
			)}
		>
			<span className={cn(text ? "block size-full" : "inline-flex", paused && "opacity-45 grayscale-[60%]")}>
				<AvatarRenderer
					definition={face.definition}
					color={face.color}
					size={text ? FACE_SIZE.mention : FACE_SIZE[size]}
					fill={text}
					animated={moodOf(state) !== "idle"}
					mood={moodOf(state)}
				/>
			</span>
			{state === "waiting" && (
				<span aria-hidden="true" className="absolute right-0 bottom-0 size-2 rounded-full bg-ink ring-2 ring-paper" />
			)}
		</span>
	);
}

/** Two overlapping faces and a count. A working member is always visible. */
export function FaceStack({
	faces,
	name,
	size = "row",
	waiting: awaiting = false,
	className,
}: {
	faces: readonly (Who & { state?: FaceState | undefined; paused?: boolean | undefined })[];
	name: string;
	size?: "message" | "row" | "panel";
	waiting?: boolean;
	className?: string;
}) {
	const box = FACE_SIZE[size];
	const faceSize = Math.round(box * 0.7);
	const offset = box - faceSize;
	const ordered = [...faces].sort((a, b) => Number(b.state === "working") - Number(a.state === "working"));
	const shown = ordered.slice(0, 2);
	const working = faces.filter((who) => who.state === "working");
	const waiting = awaiting || faces.some((who) => who.state === "waiting");
	const paused = faces.filter((who) => who.paused);
	return (
		<span
			role="img"
			aria-label={`${name}: ${faces.map((who) => who.name).join(", ")}${working.length ? `; ${working.map((who) => who.name).join(" and ")} working` : ""}${waiting ? "; waiting on you" : ""}${paused.length ? `; ${paused.map((who) => who.name).join(" and ")} routines paused` : ""}`}
			className={cn("relative inline-block shrink-0", className)}
			style={{ width: box, height: box }}
		>
			{faces.length === 0 ? (
				// a group nobody is in yet: an empty seat, not a blank
				<span
					aria-hidden="true"
					className="absolute inset-0 inline-flex items-center justify-center rounded-full border border-dashed border-line text-ink-3"
				>
					<UsersIcon style={{ width: box * 0.42, height: box * 0.42 }} />
				</span>
			) : null}
			{shown.map((who, i) => (
				<span
					key={who.id ?? who.name}
					aria-hidden="true"
					className={cn("absolute inline-flex", who.paused && "opacity-45 grayscale-[60%]")}
					style={{ left: i ? offset : 0, top: i ? offset : 0, zIndex: shown.length - i }}
				>
					<AvatarRenderer
						definition={who.face.definition}
						color={who.face.color}
						size={faceSize}
						animated={moodOf(who.state) !== "idle"}
						mood={moodOf(who.state)}
					/>
				</span>
			))}
			{faces.length > shown.length && (
				<span
					aria-hidden="true"
					className="absolute -top-1 -right-1 z-10 inline-flex min-w-4 items-center justify-center rounded-full bg-paper-3 px-0.5 text-[9px] font-semibold leading-4 text-ink ring-1 ring-paper"
				>
					+{faces.length - shown.length}
				</span>
			)}
			{waiting && (
				<span
					aria-hidden="true"
					className="absolute right-0 bottom-0 z-20 size-2 rounded-full bg-ink ring-2 ring-paper"
				/>
			)}
		</span>
	);
}
