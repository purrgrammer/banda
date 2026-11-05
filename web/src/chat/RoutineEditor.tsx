/**
 * A routine's editor, the owner's own (DESIGN.md "The app", the panel's Routines tab): what it is for, when it runs
 * (a preset, "Every weekday at 8:00", "Every day at…", "Every Monday at…", every few hours, once, or a cron line),
 * what the agent does each run; then Save, and for one that exists Run now, Pause and Delete, which asks first. "+"
 * opens the same form, empty. It replaces the panel's tabs under a bar that leads back.
 */
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	hostZone,
	nextRuns,
	parseSchedule,
	pickSchedule,
	type SchedulePick,
	zoneWords,
} from "../../../src/core/schedule.ts";
import { nearTime } from "../app/titles.ts";
import { Confirm } from "./Confirm.tsx";
import { PanelBar } from "./Panel.tsx";

/** A routine as its editor holds it: what it is for, when it runs as a pick, and what it does each run. */
export type RoutineDraft = {
	readonly description: string;
	readonly pick: SchedulePick;
	readonly ask: string;
};

/** A routine that exists, as its editor opens on it. */
export type EditedRoutine = {
	/** Its name, as words: the bar's title. */
	readonly title: string;
	readonly draft: RoutineDraft;
	readonly paused: boolean;
	/** Its last run and what came of it, in words: "Today 08:00, nothing to say". */
	readonly last?: string | undefined;
	/** The IANA time zone its times are in, when it has one: the picker's times are on that wall. */
	readonly zone?: string | undefined;
};

const EMPTY: RoutineDraft = { description: "", pick: { kind: "weekdays", time: "08:00" }, ask: "" };

const KINDS: readonly { readonly kind: SchedulePick["kind"]; readonly words: string }[] = [
	{ kind: "weekdays", words: "Every weekday at…" },
	{ kind: "daily", words: "Every day at…" },
	{ kind: "weekly", words: "Every week on…" },
	{ kind: "hours", words: "Every few hours" },
	{ kind: "once", words: "Once, at…" },
	{ kind: "custom", words: "A cron line or a period" },
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A pick of another kind, keeping the time it had where the new kind takes one. */
function switched(pick: SchedulePick, kind: SchedulePick["kind"], now: number): SchedulePick {
	const time = "time" in pick ? pick.time : "08:00";
	switch (kind) {
		case "daily":
		case "weekdays":
			return { kind, time };
		case "weekly":
			return { kind, days: [1], time };
		case "hours":
			return { kind, hours: 4 };
		case "once": {
			const tomorrow = new Date(now + 86_400_000);
			const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
			return { kind, at: `${day} ${time}` };
		}
		case "custom":
			return { kind, text: "0 8 * * 1-5" };
	}
}

/** When it next runs, in words, or why the pick says no time. */
function reading(
	pick: SchedulePick,
	now: number,
	zone?: string,
): { ok: true; line: string; next: string } | { ok: false; why: string } {
	const picked = pickSchedule(pick);
	if ("error" in picked) return { ok: false, why: picked.error };
	const when = parseSchedule(picked.text, zone);
	if (when === undefined) return { ok: false, why: "That is not a time it can run at." };
	const runs = nextRuns(when, now, now, 2);
	if (runs.length === 0) return { ok: false, why: "That time has passed: pick one still to come." };
	return { ok: true, line: picked.text, next: runs.map((at) => nearTime(at, now)).join(", then ") };
}

export function RoutineEditor({
	agent,
	routine,
	now,
	onSave,
	onRunNow,
	onPause,
	onDelete,
	onBack,
}: {
	agent: string;
	/** The routine it edits; none for a new one. */
	routine?: EditedRoutine | undefined;
	/** The time the next runs are read from. */
	now: number;
	/** Save what the form says, with when it runs as one schedule line; rejects with why the daemon refused. */
	onSave?: ((draft: RoutineDraft, when: string) => Promise<void>) | undefined;
	/** Each of these may reject with why the daemon refused, which the form says. */
	onRunNow?: (() => Promise<unknown> | undefined) | undefined;
	onPause?: ((paused: boolean) => Promise<unknown> | undefined) | undefined;
	onDelete?: (() => Promise<unknown> | undefined) | undefined;
	onBack?: (() => void) | undefined;
}) {
	const isNew = routine === undefined;
	const [draft, setDraft] = useState<RoutineDraft>(routine?.draft ?? EMPTY);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const zone = routine?.zone;
	const read = reading(draft.pick, now, zone);
	// the next runs are on this browser's clock; a routine on another wall says whose its times are
	const elsewhere = zone !== undefined && zone !== hostZone() ? ` (your time). Its times are ${zoneWords(zone)}.` : "";
	const ready = draft.description.trim() !== "" && draft.ask.trim() !== "" && read.ok;
	const set = (change: Partial<RoutineDraft>) => {
		setDraft((was) => ({ ...was, ...change }));
		setError(undefined);
	};
	const pick = draft.pick;
	const says = (failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed));
	const act = (done: Promise<unknown> | undefined) => {
		setError(undefined);
		void done?.catch(says);
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelBar
				title={isNew ? "New routine" : routine.title}
				detail={isNew ? agent : routine.paused ? "Paused" : routine.last}
				onBack={onBack}
			/>
			<form
				className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!ready || !read.ok || onSave === undefined) return;
					setSaving(true);
					void onSave(draft, read.line)
						.catch(says)
						.finally(() => setSaving(false));
				}}
			>
				<Field label="What it's for">
					<Input
						value={draft.description}
						maxLength={120}
						placeholder="Morning brief"
						onChange={(event) => set({ description: event.target.value })}
					/>
				</Field>
				<Field
					label="When"
					hint={read.ok ? `Next: ${read.next}${elsewhere}` : <span className="text-danger">{read.why}</span>}
				>
					<Select
						value={pick.kind}
						onValueChange={(kind) => set({ pick: switched(pick, kind as SchedulePick["kind"], now) })}
					>
						<SelectTrigger aria-label="How often" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{KINDS.map((each) => (
								<SelectItem key={each.kind} value={each.kind}>
									{each.words}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{pick.kind === "weekly" ? (
						<ToggleGroup
							type="multiple"
							variant="outline"
							size="sm"
							aria-label="On which days"
							value={pick.days.map(String)}
							onValueChange={(days) => set({ pick: { ...pick, days: days.map(Number) } })}
							className="w-full"
						>
							{DAYS.map((day, n) => (
								<ToggleGroupItem key={day} value={String(n)} aria-label={day} className="flex-1">
									{day.charAt(0)}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					) : null}
					{pick.kind === "daily" || pick.kind === "weekdays" || pick.kind === "weekly" ? (
						<Input
							type="time"
							aria-label="At"
							value={pick.time}
							onChange={(event) => set({ pick: { ...pick, time: event.target.value } })}
						/>
					) : pick.kind === "hours" ? (
						<span className="flex items-center gap-2 text-ui text-ink">
							Every
							<Input
								type="number"
								aria-label="Hours"
								min={1}
								max={168}
								value={pick.hours}
								onChange={(event) => set({ pick: { kind: "hours", hours: Number(event.target.value) } })}
								className="w-20"
							/>
							hours
						</span>
					) : pick.kind === "once" ? (
						<Input
							type="datetime-local"
							aria-label="At"
							value={pick.at.replace(" ", "T")}
							onChange={(event) => set({ pick: { kind: "once", at: event.target.value.replace("T", " ") } })}
						/>
					) : (
						<Input
							aria-label="Cron line"
							className="font-code"
							value={pick.text}
							placeholder="0 8 * * 1-5"
							onChange={(event) => set({ pick: { kind: "custom", text: event.target.value } })}
						/>
					)}
				</Field>
				<Field
					label={`What ${agent} does`}
					hint={`What it finds lands in ${agent}'s chat; it stays quiet if nothing does.`}
				>
					<Textarea
						value={draft.ask}
						placeholder="Tell me which of my pull requests need me, and why."
						className="min-h-28"
						onChange={(event) => set({ ask: event.target.value })}
					/>
				</Field>
				{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
				<div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
					<Button type="submit" disabled={!ready || saving || onSave === undefined}>
						{isNew ? "Add routine" : "Save"}
					</Button>
					{isNew ? (
						<Button type="button" variant="ghost" onClick={onBack}>
							Cancel
						</Button>
					) : (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => act(onRunNow?.())}
								disabled={onRunNow === undefined}
							>
								Run now
							</Button>
							<Button
								type="button"
								variant="ghost"
								onClick={() => act(onPause?.(!routine.paused))}
								disabled={onPause === undefined}
							>
								{routine.paused ? "Resume" : "Pause"}
							</Button>
							<Confirm
								title={`Delete ${routine.title}?`}
								body={`It stops waking ${agent} and its file goes. What it said stays in the chat.`}
								action="Delete"
								keep="Keep it"
								onConfirm={() => act(onDelete?.())}
							>
								<Button type="button" variant="destructive" className="ml-auto" disabled={onDelete === undefined}>
									Delete
								</Button>
							</Confirm>
						</>
					)}
				</div>
			</form>
		</div>
	);
}

/** A labelled field: the label above, a hint below in muted text. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-ui font-medium text-ink">{label}</span>
			{children}
			{hint === undefined ? null : <span className="text-meta text-ink-2">{hint}</span>}
		</div>
	);
}
