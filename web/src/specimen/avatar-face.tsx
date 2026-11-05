import { type AvatarMotion, getExample } from "open-bot-avatar";
import { createContext, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { FaceState } from "../chat/types.ts";
import { AvatarRenderer } from "./avatar-renderer.tsx";
import { CustomColour } from "./custom-colour.tsx";

/** Temporary fixture mapping: only the specimen uses it; real agent definitions are unchanged. */
export const AvatarSpecimenContext = createContext(false);
export const useAvatarSpecimen = () => useContext(AvatarSpecimenContext);
export const AvatarColorsContext = createContext<{
	colors: Record<string, string>;
	setColor: (name: string, color: string) => void;
}>({ colors: {}, setColor: () => {} });

const LOOKS: Record<string, [string, string]> = {
	"🫏": ["chat", "#8a9cc7"],
	"🦊": ["mug", "#e48c54"],
	"🐙": ["controller", "#8b85d0"],
	"🦉": ["lightbulb", "#d4ae47"],
	"🌵": ["watering-can", "#66a8a3"],
	"🐝": ["barbell", "#d99368"],
	"🦦": ["sprout", "#56a875"],
};

export function Drawing({
	emoji,
	size,
	working = false,
	color: chosenColor,
	mood,
}: {
	emoji: string;
	size: number;
	working?: boolean;
	color?: string;
	mood?: AvatarMotion;
}) {
	const [id, defaultColor] = LOOKS[emoji] ?? ["chat", "#8a9cc7"];
	const definition = getExample(id);
	if (!definition) return null;
	return (
		<AvatarRenderer
			definition={definition}
			color={chosenColor ?? defaultColor}
			size={size}
			animated={working || mood !== undefined}
			mood={mood ?? (working ? "thinking" : "idle")}
		/>
	);
}

export function AvatarChoices({
	onPick,
	name,
	initial,
}: {
	onPick: (emoji: string) => void;
	name: string;
	initial: string;
}) {
	const { colors, setColor } = useContext(AvatarColorsContext);
	const [chosen, setChosen] = useState(initial);
	const [color, setChosenColor] = useState(colors[name] ?? LOOKS[initial]?.[1] ?? "#8a9cc7");
	const palette = [
		["Sky", "#8a9cc7"],
		["Apricot", "#e48c54"],
		["Leaf", "#56a875"],
		["Lavender", "#8b85d0"],
		["Honey", "#d4ae47"],
		["Teal", "#66a8a3"],
		["Rose", "#c9707b"],
	] as const;
	const [customColors, setCustomColors] = useState<string[]>(() =>
		palette.some(([, item]) => item === color) ? [] : [color],
	);
	return (
		<div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
			<div className="flex items-center gap-3">
				<Drawing emoji={chosen} color={color} size={64} />
				<p className="text-ui font-semibold text-ink">{name || "Choose a face"}</p>
			</div>
			<fieldset>
				<legend className="mb-1 text-meta font-medium text-ink">Shape</legend>
				<div className="grid grid-cols-4 gap-1">
					{Object.keys(LOOKS).map((emoji) => (
						<button
							key={emoji}
							type="button"
							aria-label={LOOKS[emoji]?.[0] ?? "shape"}
							aria-pressed={chosen === emoji}
							onClick={() => setChosen(emoji)}
							className={cn(
								"flex items-center justify-center rounded-tile border hover:bg-paper-3 focus-visible:outline-2 focus-visible:outline-ink",
								chosen === emoji ? "border-ink" : "border-transparent",
							)}
						>
							<Drawing emoji={emoji} color={color} size={40} />
						</button>
					))}
				</div>
			</fieldset>
			<fieldset>
				<legend className="mb-1 text-meta font-medium text-ink">Colour</legend>
				<div className="flex flex-wrap gap-1">
					{palette.map(([label, value]) => (
						<button
							key={value}
							type="button"
							aria-label={label}
							aria-pressed={color === value}
							onClick={() => setChosenColor(value)}
							className={cn(
								"flex size-8 items-center justify-center rounded-full border-2",
								color === value ? "border-ink" : "border-transparent",
							)}
						>
							<span aria-hidden="true" className="size-5 rounded-full" style={{ backgroundColor: value }} />
						</button>
					))}
					{customColors.map((value) => (
						<button
							key={value}
							type="button"
							aria-label={`Custom colour ${value}`}
							aria-pressed={color === value}
							onClick={() => setChosenColor(value)}
							className={cn(
								"flex size-8 items-center justify-center rounded-full border-2 focus-visible:outline-2 focus-visible:outline-ink",
								color === value ? "border-ink" : "border-transparent",
							)}
						>
							<span aria-hidden="true" className="size-5 rounded-full" style={{ backgroundColor: value }} />
						</button>
					))}
					<CustomColour
						value={color}
						onChange={setChosenColor}
						onCommit={(value) =>
							setCustomColors((current) =>
								palette.some(([, item]) => item === value) || current.includes(value) ? current : [...current, value],
							)
						}
					/>
				</div>
			</fieldset>
			<Button
				type="button"
				className="self-start"
				onClick={() => {
					setColor(name, color);
					onPick(chosen);
				}}
			>
				Use face
			</Button>
		</div>
	);
}

const SIZES = { mention: 20, message: 28, row: 40, panel: 64, hero: 96 } as const;
export function SpecimenFace({
	emoji,
	name,
	size = "row",
	state = "idle",
	paused = false,
	className,
}: {
	emoji: string;
	name: string;
	size?: keyof typeof SIZES;
	state?: FaceState;
	paused?: boolean;
	className?: string;
}) {
	const { colors } = useContext(AvatarColorsContext);
	const words = [
		name,
		state === "working" ? "working" : state === "waiting" ? "waiting on you" : "",
		paused ? "routines paused" : "",
	]
		.filter(Boolean)
		.join(", ");
	return (
		<span role="img" aria-label={words} data-state={state} className={cn("relative inline-flex shrink-0", className)}>
			<span className={cn("inline-flex", paused && "opacity-45 grayscale-[60%]")}>
				<Drawing
					emoji={emoji}
					size={SIZES[size]}
					working={state === "working"}
					{...(colors[name] ? { color: colors[name] } : {})}
				/>
			</span>
			{state === "waiting" && (
				<span aria-hidden="true" className="absolute right-0 bottom-0 size-2 rounded-full bg-ink ring-2 ring-paper" />
			)}
		</span>
	);
}

export function SpecimenStack({
	faces,
	name,
	size = "row",
	className,
}: {
	faces: readonly { emoji: string; name: string; state?: FaceState | undefined }[];
	name: string;
	size?: "message" | "row" | "panel";
	className?: string;
}) {
	const { colors } = useContext(AvatarColorsContext);
	const box = SIZES[size];
	const faceSize = Math.round(box * 0.7);
	const offset = box - faceSize;
	const active = faces.find((face) => face.state === "working");
	const ordered = active ? [active, ...faces.filter((face) => face !== active)] : faces;
	const shown = ordered.slice(0, 2);
	const working = faces.filter((face) => face.state === "working");
	const waiting = faces.some((face) => face.state === "waiting");
	return (
		<span
			role="img"
			aria-label={`${name}: ${faces.map((face) => face.name).join(", ")}${working.length ? `; ${working.map((face) => face.name).join(" and ")} working` : ""}${waiting ? "; waiting on you" : ""}`}
			className={cn("relative inline-block shrink-0", className)}
			style={{ width: box, height: box }}
		>
			{shown.map((who, i) => (
				<span
					key={who.name}
					aria-hidden="true"
					className="absolute inline-flex"
					style={{ left: i ? offset : 0, top: i ? offset : 0, zIndex: shown.length - i }}
				>
					<Drawing
						emoji={who.emoji}
						size={faceSize}
						working={who.state === "working"}
						{...(colors[who.name] ? { color: colors[who.name] } : {})}
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
