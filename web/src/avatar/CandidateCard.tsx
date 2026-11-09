import { BrainIcon, CircleIcon, SmileIcon } from "lucide-react";
import type { AvatarDefinition, AvatarMotion } from "open-bot-avatar";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AvatarFace } from "../../../src/core/avatar-face.ts";
import { Tile } from "../chat/Cards.tsx";
import { AvatarRenderer } from "./Renderer.tsx";

/**
 * Previewing, toggling motion and leaving the card never writes identity. Only Use this face calls onUse; once the face is
 * the agent's, the card is just the preview, at the same width.
 */
export function AvatarCandidateCard({
	definition,
	current,
	name,
	onUse,
}: {
	definition: AvatarDefinition;
	current: AvatarFace;
	name: string;
	onUse: (face: AvatarFace) => Promise<void>;
}) {
	const [mood, setMood] = useState<AvatarMotion>("idle");
	const [state, setState] = useState<"preview" | "saving" | "failed">("preview");
	const saving = useRef(false);
	const same = JSON.stringify(current.definition) === JSON.stringify(definition);
	const use = async () => {
		if (saving.current || same) return;
		saving.current = true;
		setState("saving");
		try {
			await onUse({ definition, color: current.color });
			setState("preview");
		} catch {
			setState("failed");
		} finally {
			saving.current = false;
		}
	};
	return (
		<Tile className="flex w-[22rem] max-w-full flex-col gap-3 p-4">
			<div>
				<p className="text-meta text-ink-2">Face preview for {name}</p>
				<p className="text-body font-semibold text-ink">{definition.name}</p>
			</div>
			<div
				role="img"
				aria-label={`${definition.name}, face preview`}
				className="flex items-center justify-center rounded-tile bg-paper-3 py-4"
			>
				<AvatarRenderer
					definition={definition}
					color={current.color}
					size={128}
					animated={mood !== "idle"}
					mood={mood}
				/>
			</div>
			<ToggleGroup
				type="single"
				value={mood}
				onValueChange={(value) => {
					if (value === "idle" || value === "thinking" || value === "happy") setMood(value);
				}}
				aria-label="Face preview state"
				variant="outline"
				size="sm"
				spacing={0}
				className="self-center"
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
			{same ? null : (
				<>
					<p className="text-ui text-ink-2">Nothing changes until you use this face. Your colour stays the same.</p>
					<Button className="self-start" disabled={state === "saving"} onClick={() => void use()}>
						{state === "saving" ? "Applying…" : "Use this face"}
					</Button>
					{state === "failed" ? (
						<p role="alert" className="text-ui text-danger">
							Couldn't change the face. Check the agent's current settings and try again.
						</p>
					) : null}
				</>
			)}
		</Tile>
	);
}
