import { BrainIcon, CircleIcon, SmileIcon } from "lucide-react";
import type { AvatarMotion } from "open-bot-avatar";
import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import type { AvatarFace } from "../../../src/core/avatar-face.ts";
import { CustomColour } from "./CustomColour.tsx";
import { COLORS, customColors, SHAPES } from "./choices.ts";
import { AvatarRenderer } from "./Renderer.tsx";

/** Shape and colour picks apply as they are chosen; motion controls only change the preview. */
export function AvatarChoices({
	initial,
	name,
	onPick,
}: {
	initial: AvatarFace;
	name: string;
	onPick: (face: AvatarFace) => void;
}) {
	const [definition, setDefinition] = useState(initial.definition);
	const [color, setColor] = useState(initial.color);
	const [added, setAdded] = useState<string[]>([]);
	const [mood, setMood] = useState<AvatarMotion>("idle");
	const shapes = SHAPES.some((shape) => JSON.stringify(shape.definition) === JSON.stringify(initial.definition))
		? SHAPES
		: [{ id: "current", name: "Current shape", definition: initial.definition }, ...SHAPES];
	return (
		<div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
			<span
				role="img"
				aria-label={`${name || "Agent"}, face preview`}
				className="flex items-center justify-center rounded-tile bg-paper-3 py-4"
			>
				<AvatarRenderer definition={definition} color={color} size={128} animated={mood !== "idle"} mood={mood} />
			</span>
			<div className="flex items-center justify-between gap-3">
				<p className="min-w-0 truncate text-ui font-semibold text-ink">{name || "Choose a face"}</p>
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
			<fieldset>
				<legend className="mb-1 text-meta font-medium text-ink">Shape</legend>
				<div className="grid grid-cols-4 gap-1">
					{shapes.map((shape) => {
						const selected = JSON.stringify(definition) === JSON.stringify(shape.definition);
						return (
							<button
								key={shape.id}
								type="button"
								aria-label={shape.name}
								aria-pressed={selected}
								onClick={() => {
									setDefinition(shape.definition);
									onPick({ definition: shape.definition, color });
								}}
								className={cn(
									"flex min-h-16 items-center justify-center rounded-tile border hover:bg-paper-3 focus-visible:outline-2 focus-visible:outline-ink",
									selected ? "border-ink" : "border-transparent",
								)}
							>
								<AvatarRenderer definition={shape.definition} color={color} size={56} />
							</button>
						);
					})}
				</div>
			</fieldset>
			<fieldset>
				<legend className="mb-1 text-meta font-medium text-ink">Colour</legend>
				<div className="flex flex-wrap gap-1">
					{[
						...COLORS,
						...customColors(initial.color, added).map((value) => ({ name: `Custom colour ${value}`, value })),
					].map((item) => (
						<button
							key={item.value}
							type="button"
							aria-label={item.name}
							aria-pressed={color === item.value}
							onClick={() => {
								setColor(item.value);
								onPick({ definition, color: item.value });
							}}
							className={cn(
								"flex size-10 items-center justify-center rounded-full border-2 focus-visible:outline-2 focus-visible:outline-ink",
								color === item.value ? "border-ink" : "border-transparent",
							)}
						>
							<span aria-hidden="true" className="size-7 rounded-full" style={{ backgroundColor: item.value }} />
						</button>
					))}
					<CustomColour
						value={color}
						onChange={setColor}
						onCommit={(value) => {
							setColor(value);
							setAdded((current) => customColors(value, current));
							onPick({ definition, color: value });
						}}
					/>
				</div>
			</fieldset>
		</div>
	);
}
