import { type AvatarDefinition, type AvatarMotion, getExample } from "open-bot-avatar";
import { cn } from "@/lib/cn";
import { AvatarRenderer } from "./avatar-renderer.tsx";
import { Group, Section } from "./stage.tsx";

type Shape = { definition: AvatarDefinition; color: string; name: string };

function shape(id: string, color: string, name: string): Shape {
	const definition = getExample(id);
	if (!definition) throw new Error(`Missing avatar example: ${id}`);
	return { definition, color, name };
}

const BAND = [
	shape("sprout", "#56a875", "Mara"),
	shape("mug", "#e48c54", "Sancho"),
	shape("controller", "#8b85d0", "Octo"),
	shape("lightbulb", "#d4ae47", "Atlas"),
] as const;

/** The library owns the host contents; React owns its lifecycle. */
function Avatar({
	who,
	size,
	animated = false,
	mood = "idle",
}: {
	who: Shape;
	size: number;
	animated?: boolean;
	mood?: AvatarMotion;
}) {
	return <AvatarRenderer definition={who.definition} color={who.color} size={size} animated={animated} mood={mood} />;
}

function Face({
	who,
	size = 40,
	state = "idle",
	paused = false,
}: {
	who: Shape;
	size?: number;
	state?: "idle" | "working" | "waiting";
	paused?: boolean;
}) {
	const words = [
		who.name,
		state === "working" ? "working" : state === "waiting" ? "waiting on you" : "",
		paused ? "routines paused" : "",
	]
		.filter(Boolean)
		.join(", ");
	return (
		<span role="img" aria-label={words} className="relative inline-flex shrink-0">
			<span className={cn("inline-flex", paused && "opacity-45 grayscale-[60%]")}>
				<Avatar who={who} size={size} animated={state === "working"} mood={state === "working" ? "thinking" : "idle"} />
			</span>
			<StatusMark state={state} />
		</span>
	);
}

function StatusMark({ state }: { state: "idle" | "working" | "waiting" }) {
	if (state !== "waiting") return null;
	return (
		<span aria-hidden="true" className="absolute right-0 bottom-0 z-20 size-2 rounded-full bg-ink ring-2 ring-paper" />
	);
}

/** Two faces and a count fit the existing row, header and panel slots. */
function Stack({
	faces,
	working,
	waiting = false,
	size = 40,
}: {
	faces: readonly Shape[];
	working?: string;
	waiting?: boolean;
	size?: 28 | 40 | 64;
}) {
	const faceSize = Math.round(size * 0.7);
	const offset = size - faceSize;
	const active = faces.find((face) => face.name === working);
	const ordered = active ? [active, ...faces.filter((face) => face !== active)] : faces;
	const shown = ordered.slice(0, 2);
	const others = ordered.slice(shown.length);
	return (
		<span
			role="img"
			aria-label={`Group: ${faces.map((face) => face.name).join(", ")}${working ? `; ${working} working` : ""}${waiting ? "; waiting on you" : ""}`}
			className="relative inline-block shrink-0"
			style={{ width: size, height: size }}
		>
			{shown.map((who, i) => (
				<span
					key={who.name}
					aria-hidden="true"
					className="absolute inline-flex items-center justify-center"
					style={{
						left: i === 0 ? 0 : offset,
						top: i === 0 ? 0 : offset,
						width: faceSize,
						height: faceSize,
						zIndex: shown.length - i,
					}}
				>
					<Avatar
						who={who}
						size={faceSize}
						animated={who.name === working}
						mood={who.name === working ? "thinking" : "idle"}
					/>
				</span>
			))}
			{others.length > 0 && (
				<span
					aria-hidden="true"
					className="absolute -top-1 -right-1 z-10 inline-flex min-w-4 items-center justify-center rounded-full bg-paper-3 px-0.5 text-[9px] font-semibold leading-4 text-ink ring-1 ring-paper"
				>
					+{others.length}
				</span>
			)}
			<StatusMark state={waiting ? "waiting" : working ? "working" : "idle"} />
		</span>
	);
}

function Example({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-h-20 flex-col items-start justify-end gap-2">
			<div className="flex min-h-12 items-center">{children}</div>
			<span className="text-meta text-ink-2">{label}</span>
		</div>
	);
}

export function AvatarSpike() {
	return (
		<Section
			id="avatar-spike"
			title="Avatar shapes · exploration"
			note="A specimen only. A quiet dot marks waiting; working is shown by thinking motion and the accompanying text. Reduced motion is respected."
		>
			<Group label="Sizes: first run 96 · panel 64 · row 40 · message 28">
				{[96, 64, 40, 28].map((size) => (
					<Face key={size} who={BAND[0]} size={size} />
				))}
			</Group>
			<Group label="States: working and waiting are also written in the interface" className="gap-6">
				<Example label="Idle">
					<Face who={BAND[1]} />
				</Example>
				<Example label="Working">
					<Face who={BAND[1]} state="working" />
				</Example>
				<Example label="Waiting on you">
					<Face who={BAND[1]} state="waiting" />
				</Example>
				<Example label="Routines paused">
					<Face who={BAND[1]} paused />
				</Example>
			</Group>
			<Group label="Groups: 40px row slot · the working member comes forward" className="gap-6">
				<Example label="Two · Mara working">
					<Stack faces={BAND.slice(0, 2)} working="Mara" />
				</Example>
				<Example label="Two · Sancho working">
					<Stack faces={BAND.slice(0, 2)} working="Sancho" />
				</Example>
				<Example label="Three · Octo working">
					<Stack faces={BAND.slice(0, 3)} working="Octo" />
				</Example>
				<Example label="Four · Atlas working">
					<Stack faces={BAND} working="Atlas" />
				</Example>
				<Example label="Panel · Sancho working">
					<Stack faces={BAND.slice(0, 2)} working="Sancho" size={64} />
				</Example>
			</Group>
			<Group label="In context: sidebar, collapsed rail, chat header and group panel" className="items-start gap-5">
				<div className="flex w-64 max-w-full flex-col gap-3 rounded-tile border border-line bg-paper-2 p-3">
					<p className="text-meta font-medium text-ink-2">Group conversations</p>
					<div className="flex items-center gap-3">
						<Stack faces={BAND} working="Octo" />
						<div className="min-w-0">
							<p className="text-ui font-semibold text-ink">Weekend plans</p>
							<p className="truncate text-meta text-ink-2">Octo is thinking…</p>
						</div>
					</div>
					<div className="flex items-center gap-3">
						<Stack faces={BAND.slice(0, 2)} waiting />
						<div className="min-w-0">
							<p className="text-ui font-semibold text-ink">Trip</p>
							<p className="truncate text-meta text-ink">Waiting: book the train?</p>
						</div>
					</div>
					<div className="flex items-center gap-4 border-t border-line pt-3">
						<Stack faces={BAND} working="Atlas" />
						<span className="text-meta text-ink-2">Collapsed rail · working</span>
					</div>
					<div className="flex items-center gap-2 border-t border-line pt-3">
						<Stack faces={BAND} size={28} waiting />
						<div>
							<p className="text-ui font-semibold text-ink">Weekend plans</p>
							<p className="text-meta text-ink-2">Waiting on you</p>
						</div>
					</div>
					<div className="flex items-center gap-3 border-t border-line pt-3">
						<Stack faces={BAND} size={64} working="Sancho" />
						<div>
							<p className="text-ui font-semibold text-ink">Weekend plans</p>
							<p className="text-meta text-ink-2">4 members · Sancho working</p>
						</div>
					</div>
				</div>
			</Group>
			<Group label="Large preview: idle · thinking · happy (respects reduced motion)" className="gap-5">
				{(["idle", "thinking", "happy"] as const).map((mood) => (
					<div key={mood} className="flex flex-col items-center gap-1 text-meta text-ink-2">
						<span role="img" aria-label={`${BAND[0].name}, ${mood}`}>
							<Avatar who={BAND[0]} size={96} animated mood={mood} />
						</span>
						{mood}
					</div>
				))}
			</Group>
		</Section>
	);
}
