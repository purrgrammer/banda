import type { AvatarDefinition } from "open-bot-avatar";
import { useRef, useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { failureWords } from "@/lib/attempt.ts";

/**
 * A face from words, in place: the owner describes it (or leaves it blank, and the name is the description), the daemon
 * designs and validates one, and it becomes the face being picked. Nothing is saved here; the form it sits in does
 * that. Make one again for another.
 */
export function DescribeFace({
	name,
	design,
	onDesigned,
}: {
	name: string;
	/** Design one: resolves with a validated definition, rejects with why. */
	design: (description: string, name: string) => Promise<AvatarDefinition>;
	onDesigned: (definition: AvatarDefinition) => void;
}) {
	const [described, setDescribed] = useState("");
	const [state, setState] = useState<"idle" | "designing" | "made">("idle");
	const [error, setError] = useState<string | undefined>(undefined);
	// only the newest request answers: an older one finishing late never replaces the face
	const latest = useRef(0);
	const blank = described.trim() === "" && name.trim() === "";
	const make = async () => {
		if (blank || state === "designing") return;
		const mine = ++latest.current;
		setState("designing");
		setError(undefined);
		try {
			const definition = await design(described.trim(), name.trim());
			if (mine !== latest.current) return;
			onDesigned(definition);
			setState("made");
		} catch (failed) {
			if (mine !== latest.current) return;
			setError(failureWords(failed));
			setState("idle");
		}
	};
	return (
		<div className="flex flex-col gap-1.5">
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
			<label className="flex flex-col gap-1.5">
				<span className="text-ui font-medium text-ink">Or describe its face</span>
				<InputGroup>
					<InputGroupInput
						value={described}
						onChange={(event) => setDescribed(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							void make();
						}}
						maxLength={500}
						placeholder={
							name.trim() === "" ? "A teapot, a paper plane, a cactus" : `Leave blank to draw ${name.trim()}`
						}
					/>
					<InputGroupAddon align="inline-end">
						<InputGroupButton variant="secondary" disabled={blank || state === "designing"} onClick={() => void make()}>
							{state === "designing" ? (
								<>
									<Spinner />
									Drawing…
								</>
							) : state === "made" ? (
								"Another"
							) : (
								"Make one"
							)}
						</InputGroupButton>
					</InputGroupAddon>
				</InputGroup>
			</label>
			{error === undefined ? (
				<span className="text-meta text-ink-2">
					{state === "designing"
						? "This takes a little while."
						: "Drawn from your words, or its name. Pick a shape instead any time."}
				</span>
			) : (
				<span role="alert" className="text-meta text-danger">
					{error}
				</span>
			)}
		</div>
	);
}
