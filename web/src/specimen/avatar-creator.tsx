import { BrainIcon, CircleIcon, SmileIcon } from "lucide-react";
import type { AvatarMotion } from "open-bot-avatar";
import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { AvatarChoices } from "../avatar/Choices.tsx";
import { Face } from "../chat/Face.tsx";
import { Drawing } from "./avatar-face.tsx";
import { CustomColour } from "./custom-colour.tsx";
import { Group, Section } from "./stage.tsx";

const SHAPES = [
	{ key: "🫏", name: "Chat" },
	{ key: "🦊", name: "Mug" },
	{ key: "🐙", name: "Controller" },
	{ key: "🦉", name: "Lightbulb" },
	{ key: "🌵", name: "Watering can" },
	{ key: "🐝", name: "Barbell" },
	{ key: "🦦", name: "Sprout" },
] as const;
const COLORS = [
	{ name: "Sky", value: "#8a9cc7" },
	{ name: "Apricot", value: "#e48c54" },
	{ name: "Leaf", value: "#56a875" },
	{ name: "Lavender", value: "#8b85d0" },
	{ name: "Honey", value: "#d4ae47" },
	{ name: "Teal", value: "#66a8a3" },
	{ name: "Rose", value: "#c9707b" },
] as const;

function Creator() {
	const [shape, setShape] = useState<string>(SHAPES[0].key);
	const [color, setColor] = useState<string>(COLORS[0].value);
	const [customColors, setCustomColors] = useState<string[]>([]);
	const [mood, setMood] = useState<AvatarMotion>("idle");

	return (
		<div className="flex w-full max-w-[28rem] flex-col gap-5">
			<div className="flex items-center gap-5 rounded-tile bg-paper-2 p-4">
				<Drawing emoji={shape} size={96} color={color} mood={mood} />
				<div className="flex min-w-0 flex-col gap-2">
					<p className="text-ui font-semibold text-ink">Mara</p>
					<ToggleGroup
						type="single"
						value={mood}
						onValueChange={(value) => {
							if (value === "idle" || value === "thinking" || value === "happy") setMood(value);
						}}
						aria-label="Preview state"
						variant="outline"
						size="sm"
						spacing={0}
					>
						<ToggleGroupItem value="idle" aria-label="Idle" title="Idle">
							<CircleIcon aria-hidden="true" />
						</ToggleGroupItem>
						<ToggleGroupItem value="thinking" aria-label="Thinking" title="Thinking">
							<BrainIcon aria-hidden="true" />
						</ToggleGroupItem>
						<ToggleGroupItem value="happy" aria-label="Happy" title="Happy">
							<SmileIcon aria-hidden="true" />
						</ToggleGroupItem>
					</ToggleGroup>
				</div>
			</div>
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-2 text-ui font-medium text-ink">Shape</legend>
				<div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
					{SHAPES.map((item) => (
						<button
							key={item.key}
							type="button"
							aria-label={item.name}
							aria-pressed={shape === item.key}
							onClick={() => setShape(item.key)}
							className={cn(
								"flex aspect-square items-center justify-center rounded-tile border bg-paper-2 hover:bg-paper-3 focus-visible:outline-2 focus-visible:outline-ink",
								shape === item.key ? "border-ink" : "border-transparent",
							)}
						>
							<Drawing emoji={item.key} size={44} color={color} />
						</button>
					))}
				</div>
			</fieldset>
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-2 text-ui font-medium text-ink">Colour</legend>
				<div className="flex flex-wrap gap-2">
					{COLORS.map((item) => (
						<button
							key={item.value}
							type="button"
							aria-label={item.name}
							aria-pressed={color === item.value}
							onClick={() => setColor(item.value)}
							className={cn(
								"flex size-10 items-center justify-center rounded-full border-2 focus-visible:outline-2 focus-visible:outline-ink",
								color === item.value ? "border-ink" : "border-transparent",
							)}
						>
							<span aria-hidden="true" className="size-7 rounded-full" style={{ backgroundColor: item.value }} />
						</button>
					))}
					{customColors.map((value) => (
						<button
							key={value}
							type="button"
							aria-label={`Custom colour ${value}`}
							aria-pressed={color === value}
							onClick={() => setColor(value)}
							className={cn(
								"flex size-10 items-center justify-center rounded-full border-2 focus-visible:outline-2 focus-visible:outline-ink",
								color === value ? "border-ink" : "border-transparent",
							)}
						>
							<span aria-hidden="true" className="size-7 rounded-full" style={{ backgroundColor: value }} />
						</button>
					))}
					<CustomColour
						value={color}
						onChange={setColor}
						onCommit={(value) =>
							setCustomColors((current) =>
								COLORS.some((item) => item.value === value) || current.includes(value) ? current : [...current, value],
							)
						}
					/>
				</div>
			</fieldset>
		</div>
	);
}

export function AvatarIcon() {
	return (
		<Section
			id="avatar-icon"
			title="App icon · exploration"
			note="A preview of the default face as the installed app icon."
		>
			<Group label="Install icon · standard and maskable">
				{(["standard", "maskable"] as const).map((variant) => (
					<div key={variant} className="flex flex-col items-center gap-2">
						<span
							className="flex size-24 items-center justify-center overflow-hidden rounded-[22px] border border-line bg-paper-2"
							role="img"
							aria-label={`${variant} app icon, chat bubble`}
						>
							<Drawing emoji="🫏" size={variant === "standard" ? 78 : 64} />
						</span>
						<span className="text-meta text-ink-2">{variant}</span>
					</div>
				))}
			</Group>
		</Section>
	);
}

export function AvatarCreator() {
	const [face, setFace] = useState(defaultAvatarFace);
	return (
		<Section
			id="avatar-creator"
			title="Choose a face"
			note="Specimen choices stay here; the app saves them to the agent."
		>
			<Creator />
			<Group label="The app's picker · shape and colour are accepted together" className="items-start">
				<div className="w-80 max-w-full rounded-tile border border-line">
					<AvatarChoices initial={face} name="Mara" onPick={setFace} />
				</div>
				<Face face={face} name="Mara, chosen face" size="panel" />
			</Group>
		</Section>
	);
}
