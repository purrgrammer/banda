/**
 * First run on the desktop (and Settings, any time), in place of banda's own skills when other harnesses are set up on this computer (Claude
 * Code, Codex, pi): the owner picks the harnesses to bring from, and sees what that brings, every skill and agent, each
 * of which they may leave behind. A name two picked harnesses share comes from the first. Each harness says how the
 * band can hand it coding work: its ACP adapter to install, or that it is ready to connect. Starting fresh goes on to
 * banda's own skills.
 */
import { CheckIcon } from "lucide-react";
import { CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { Face } from "./Face.tsx";
import { HarnessMark } from "./Harness.tsx";

const FIRST_FACE = defaultAvatarFace();

export type BringKind = "skills" | "agents";

export type BringItem = {
	readonly name: string;
	readonly about: string;
	readonly added: boolean;
	readonly problem?: string | undefined;
};

export type BringHarness = {
	readonly name: string;
	readonly service: string;
	/** Its folder, from ~. */
	readonly folder: string;
	readonly provider?: string | undefined;
	readonly logo?: string | undefined;
	readonly skills: readonly BringItem[];
	readonly agents: readonly BringItem[];
	/** How the band hands it coding work: its adapter's install command, or ready to connect once in. */
	readonly connect?: { readonly install: string } | "ready" | undefined;
};

/** An item's key: its kind, then its name. */
export const pickKey = (kind: BringKind, name: string) => `${kind}:${name}`;

/** One line of the preview: an item, the harness it comes from, and whether it comes along. */
export type PreviewRow = {
	readonly kind: BringKind;
	readonly item: BringItem;
	readonly harness: BringHarness;
	/** It can come along: not in banda already, nothing wrong with it. */
	readonly open: boolean;
	readonly on: boolean;
};

/**
 * What the picked harnesses bring, in their order: each name once, from the first harness that has it able to come
 * along; skills, then agents. `left` is what the owner left behind, by `pickKey`.
 */
export function preview(
	harnesses: readonly BringHarness[],
	picked: ReadonlySet<string>,
	left: ReadonlySet<string>,
): PreviewRow[] {
	const rows: PreviewRow[] = [];
	for (const kind of ["skills", "agents"] as const) {
		const seen = new Map<string, number>();
		for (const harness of harnesses) {
			if (!picked.has(harness.name)) continue;
			for (const item of harness[kind]) {
				const open = !item.added && item.problem === undefined;
				const at = seen.get(item.name);
				if (at !== undefined) {
					// a name shared: the first that can bring it does
					if (rows[at]?.open === true || !open) continue;
					rows[at] = { kind, item, harness, open, on: !left.has(pickKey(kind, item.name)) };
					continue;
				}
				seen.set(item.name, rows.length);
				rows.push({ kind, item, harness, open, on: open && !left.has(pickKey(kind, item.name)) });
			}
		}
	}
	return rows.sort((a, b) => Number(b.open) - Number(a.open));
}

/** What the button brings, in words: "22 skills and 1 agent"; empty when nothing. */
export function bringWords(rows: readonly PreviewRow[]): string {
	const bringing = rows.filter((row) => row.on);
	return (["skills", "agents"] as const)
		.flatMap((kind) => {
			const n = bringing.filter((row) => row.kind === kind).length;
			return n === 0 ? [] : [`${n} ${n === 1 ? kind.slice(0, -1) : kind}`];
		})
		.join(" and ");
}

type PickerProps = {
	harnesses: readonly BringHarness[];
	/** The harnesses picked, by name. */
	picked: ReadonlySet<string>;
	/** What the owner left behind, by `pickKey`. */
	left: ReadonlySet<string>;
	busy?: boolean;
	onHarness?: ((harness: string, on: boolean) => void) | undefined;
	onItem?: ((kind: BringKind, name: string, on: boolean) => void) | undefined;
};

/** The harnesses to bring from, and what the picked ones bring: at first run and in Settings. */
export function BringPicker({ harnesses, picked, left, busy = false, onHarness, onItem }: PickerProps) {
	const rows = preview(harnesses, picked, left);
	const showFrom = picked.size > 1;
	return (
		<div className="flex w-full flex-col gap-6">
			<ul aria-label="Harnesses on this computer" className="flex w-full flex-col gap-2">
				{harnesses.map((harness) => (
					<HarnessCard
						key={harness.name}
						harness={harness}
						on={picked.has(harness.name)}
						busy={busy}
						onChange={(on) => onHarness?.(harness.name, on)}
					/>
				))}
			</ul>
			{rows.length === 0 ? null : (
				<section aria-label="What comes along" className="flex w-full flex-col gap-2">
					<h3 className="text-meta font-medium text-ink-2">What comes along</h3>
					<ul className="flex max-h-96 flex-col divide-y divide-line-soft overflow-y-auto rounded-tile border border-line-soft">
						{rows.map((row) => (
							<PreviewLine
								key={pickKey(row.kind, row.item.name)}
								row={row}
								showFrom={showFrom}
								busy={busy}
								onChange={(on) => onItem?.(row.kind, row.item.name, on)}
							/>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

export function FirstBring({
	error,
	onBring,
	onFresh,
	...picker
}: PickerProps & {
	error?: string | undefined;
	onBring?: () => void;
	/** Bring nothing: banda's own skills come next. */
	onFresh?: () => void;
}) {
	const { harnesses, picked, left, busy = false } = picker;
	const words = bringWords(preview(harnesses, picked, left));
	return (
		<div className="flex h-full flex-col items-center overflow-y-auto bg-paper px-4 py-12">
			<div className="flex w-full max-w-md shrink-0 flex-col items-center gap-3 text-center">
				<Face face={FIRST_FACE} name="Sancho" size="hero" />
				<h1 className="mt-2 text-display font-semibold text-ink">Bring your skills and agents</h1>
				<p className="text-body text-ink-2">
					You already work with {listOf(harnesses.map((one) => one.service))} here. banda can copy what they have; the
					originals stay where they are.
				</p>
			</div>
			<div className="mt-8 flex w-full max-w-md shrink-0">
				<BringPicker {...picker} />
			</div>
			{error === undefined ? null : (
				<p role="alert" className="mt-4 max-w-md text-center text-ui text-danger">
					{error}
				</p>
			)}
			<div className="mt-6 flex w-full max-w-md shrink-0 flex-col gap-2">
				{words === "" ? (
					<Button size="lg" disabled={busy} onClick={() => onFresh?.()}>
						Start fresh
					</Button>
				) : (
					<>
						<Button size="lg" disabled={busy} onClick={() => onBring?.()}>
							Bring {words}
						</Button>
						<Button variant="ghost" disabled={busy} onClick={() => onFresh?.()}>
							Start fresh instead
						</Button>
					</>
				)}
			</div>
			<p className="mt-4 max-w-md text-center text-meta text-ink-2">
				{words === ""
					? "Starting fresh, you pick from the skills banda comes with next."
					: "They become banda's own copies: change them later on the Skills page and in each agent."}
			</p>
		</div>
	);
}

/**
 * In Settings, on the desktop: the same picker, any time, to bring more. What came in last is said under the button.
 * With nothing new anywhere, it says so.
 */
export function BringBlock({
	error,
	done,
	onBring,
	...picker
}: PickerProps & {
	error?: string | undefined;
	/** What the last bring brought, in words. */
	done?: string | undefined;
	onBring?: () => void;
}) {
	const { harnesses, picked, left, busy = false } = picker;
	const words = bringWords(preview(harnesses, picked, left));
	if (harnesses.length === 0)
		return (
			<p className="text-ui text-ink-2">
				{done === undefined
					? "Nothing new to bring from Claude Code, Codex or pi on this computer."
					: `Brought ${done}. Nothing else new to bring.`}
			</p>
		);
	return (
		<div className="flex flex-col gap-3">
			<BringPicker {...picker} />
			{error === undefined ? null : (
				<p role="alert" className="text-ui text-danger">
					{error}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-3">
				<Button disabled={busy || words === ""} onClick={() => onBring?.()}>
					{words === "" ? "Pick what to bring" : `Bring ${words}`}
				</Button>
				{done === undefined ? null : <span className="text-ui text-ink-2">Brought {done}.</span>}
			</div>
		</div>
	);
}

const listOf = (names: readonly string[]) =>
	names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

function HarnessCard({
	harness,
	on,
	busy,
	onChange,
}: {
	harness: BringHarness;
	on: boolean;
	busy: boolean;
	onChange: (on: boolean) => void;
}) {
	const id = `bring-harness-${harness.name}`;
	const open = (kind: BringKind) => harness[kind].filter((item) => !item.added && item.problem === undefined).length;
	const skills = open("skills");
	const agents = open("agents");
	const has = [
		skills === 0 ? undefined : `${skills} ${skills === 1 ? "skill" : "skills"}`,
		agents === 0 ? undefined : `${agents} ${agents === 1 ? "agent" : "agents"}`,
	].filter((each) => each !== undefined);
	const empty = has.length === 0;
	return (
		<li
			className={cn(
				"flex flex-col gap-2 rounded-tile border px-3.5 py-3",
				on ? "border-ink-2 bg-paper-2" : "border-line-soft",
			)}
		>
			<label htmlFor={id} className={cn("flex items-center gap-3", empty ? "cursor-default" : "cursor-pointer")}>
				<span className="flex size-8 shrink-0 items-center justify-center rounded-field bg-paper-3">
					<HarnessMark provider={harness.provider} logo={harness.logo} className="size-5" />
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-ui font-medium text-ink">{harness.service}</span>
					<span className="truncate text-meta text-ink-2">
						<span className="font-mono">{harness.folder}</span> · {empty ? "nothing new to bring" : has.join(", ")}
					</span>
				</span>
				<Checkbox id={id} checked={on} disabled={empty || busy} onCheckedChange={(next) => onChange(next === true)} />
			</label>
			<Tip harness={harness} />
		</li>
	);
}

function PreviewLine({
	row,
	showFrom,
	busy,
	onChange,
}: {
	row: PreviewRow;
	showFrom: boolean;
	busy: boolean;
	onChange: (on: boolean) => void;
}) {
	const { kind, item, harness } = row;
	const id = `bring-${kind}-${item.name}`;
	const note = item.added
		? kind === "skills"
			? "In banda already"
			: "banda has an agent of that name already"
		: item.problem;
	return (
		<li>
			<label
				htmlFor={id}
				className={cn("flex w-full items-center gap-3 px-3.5 py-2.5", row.open ? "cursor-pointer" : "opacity-60")}
			>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="flex items-baseline gap-2">
						<span className="truncate font-mono text-ui font-medium text-ink">
							{kind === "skills" ? `/${item.name}` : item.name}
						</span>
						<span className="shrink-0 text-meta text-ink-2">
							{kind === "agents" ? "agent" : null}
							{kind === "agents" && showFrom ? " · " : null}
							{showFrom ? harness.service : null}
						</span>
					</span>
					{item.about === "" ? null : <span className="line-clamp-2 text-meta text-ink-2">{item.about}</span>}
					{note === undefined ? null : <span className="text-meta text-ink-2">{note}</span>}
				</span>
				{row.open ? (
					<Checkbox id={id} checked={row.on} disabled={busy} onCheckedChange={(next) => onChange(next === true)} />
				) : item.added ? (
					<CheckIcon aria-label="In banda already" className="size-4 text-ink-2" />
				) : null}
			</label>
		</li>
	);
}

/** How the band can hand this harness coding work: the ACP adapter to install first, or ready once in. */
function Tip({ harness }: { harness: BringHarness }) {
	if (harness.connect === undefined) return null;
	if (harness.connect === "ready")
		return (
			<p className="text-meta text-ink-2">
				The band can hand {harness.service} coding work too: connect it in Connections once you're in.
			</p>
		);
	return (
		<div className="flex flex-col gap-1.5">
			<p className="text-meta text-ink-2">
				To hand {harness.service} coding work from the band, install its ACP adapter, then connect it in Connections:
			</p>
			<span className="flex min-w-0 items-center gap-2 rounded-field bg-paper px-3 py-1.5">
				<code className="min-w-0 flex-1 font-code text-meta break-all text-ink">{harness.connect.install}</code>
				<CodeBlockCopyButton
					text={harness.connect.install}
					label={`Copy how to install ${harness.service}'s adapter`}
				/>
			</span>
		</div>
	);
}
