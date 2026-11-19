/** Shared skills, from the accepted workspace files. Draft box changes never appear as usable instructions. */
import { BookOpenIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPage } from "../chat/Settings.tsx";
import { SkillDetail, SkillList } from "../chat/Skill.tsx";
import {
	acceptSkill,
	acceptSkills,
	chooseShippedSkills,
	runsOnDevice,
	type ShippedSkillView,
	type SkillView,
	saveSkill,
	shippedSkills,
	skills,
} from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { NAME_RULE, offersLeft, skillFormState } from "../lib/skill-page.ts";

const CHANGED = "banda.skills-changed";

/**
 * The skills, read once for every place that shows them, and never by two requests at a time: the list carries each
 * skill's text and files, so it is large (a megabyte in a home with a dozen skills). The daemon's own page reads it
 * again every `EVERY`, which costs it nothing. A device does not: its bytes may come through a relay that carries tens
 * of kilobytes a second, where asking again every few seconds leaves no room for anything else. It reads again when
 * the app comes back to the front, and when a skill was changed from here.
 */
const EVERY = 15_000;
const EMPTY: SkillView[] = [];
const store = (() => {
	let list = EMPTY;
	let reading: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const readers = new Set<() => void>();
	/** Whoever asks while it is being read waits for that reading; a reading asked for meanwhile follows it, once. */
	let again = false;
	/** Whether the list was ever read: a place that shows it later is handed what is known, and asks nothing. */
	let known = false;
	const reload = (): Promise<void> => {
		if (reading !== undefined) {
			again = true;
			return reading;
		}
		reading = (async () => {
			try {
				do {
					again = false;
					list = await skills();
					known = true;
					for (const reader of readers) reader();
				} while (again);
			} finally {
				reading = undefined;
			}
		})();
		return reading;
	};
	const quietly = () => void reload().catch(() => {});
	const fronted = () => {
		if (document.visibilityState === "visible") quietly();
	};
	return {
		get: () => list,
		reload,
		subscribe(reader: () => void) {
			readers.add(reader);
			if (readers.size === 1) {
				if (!known && reading === undefined) quietly();
				addEventListener(CHANGED, quietly);
				if (runsOnDevice) document.addEventListener("visibilitychange", fronted);
				else timer = setInterval(quietly, EVERY);
			}
			return () => {
				readers.delete(reader);
				if (readers.size > 0) return;
				removeEventListener(CHANGED, quietly);
				document.removeEventListener("visibilitychange", fronted);
				clearInterval(timer);
			};
		},
	};
})();

export function useSkills() {
	return { list: useSyncExternalStore(store.subscribe, store.get), reload: store.reload };
}

const changed = () => dispatchEvent(new Event(CHANGED));
/** Skills changed elsewhere (a bring): every list of them reads again. */
export const skillsChanged = changed;

/** A skill the owner can act on: a file the box added or changed. A removal has nothing to allow (the accepted text stays). */
export const waitsOnOwner = (view: SkillView) => view.change !== undefined && view.change.kind !== "removed";

export function SkillsPage({
	name,
	phone,
	onBack,
	onOpen,
}: {
	name?: string;
	phone: boolean;
	onBack: () => void;
	onOpen: (name: string) => void;
}) {
	const { list, reload } = useSkills();
	const [editing, setEditing] = useState(false);
	// an editor left open belongs to the page it was opened on, not the next one
	// biome-ignore lint/correctness/useExhaustiveDependencies: name is the page
	useEffect(() => {
		setEditing(false);
	}, [name]);
	const [shipped, setShipped] = useState<readonly ShippedSkillView[]>();
	useEffect(() => {
		void shippedSkills()
			.then((view) => setShipped(view.skills))
			.catch(() => {});
	}, []);
	const selected = list.find((item) => item.name === name);
	const accepted = selected?.accepted;
	const present = new Set(list.map((item) => item.name));
	const existing = list.flatMap((item) => (item.accepted === undefined ? [] : [item.name]));
	const save = (target: string, text: string, base: string | null) =>
		attempt("save the skill", async () => {
			await saveSkill(target, text, base);
			setEditing(false);
			await reload();
			changed();
			if (name === undefined) onOpen(target);
		});
	return (
		<SettingsPage
			title={name === undefined ? "Skills" : `/${name}`}
			parent={name === undefined ? undefined : { title: "Skills", href: "#/skills" }}
			icon={BookOpenIcon}
			phone={phone}
			onBack={onBack}
			wide={name !== undefined}
		>
			{name === undefined ? (
				<>
					<Waiting list={list} onOpen={onOpen} reload={reload} />
					<section className="flex flex-col gap-3">
						<p className="text-ui text-ink-2">
							Shared with every agent. Use /name in a message, or let an agent load one when its work fits.
						</p>
						<SkillList
							skills={list.flatMap(({ accepted, change }) =>
								accepted === undefined
									? []
									: [
											{
												name: accepted.name,
												description: accepted.description,
												...(accepted.ownerOnly === true ? { ownerOnly: true } : {}),
												...(change !== undefined && change.kind !== "removed" ? { changed: true } : {}),
											},
										],
							)}
							hrefFor={(value) => `#/skills/${value}`}
						/>
					</section>
					{shipped === undefined ? null : (
						<FromBanda
							offers={offersLeft(shipped).filter(({ name: offer }) => !present.has(offer))}
							onAdd={(offer) =>
								void attempt("add the skill", async () => {
									setShipped((await chooseShippedSkills([offer])).skills);
									await reload();
									changed();
								})
							}
						/>
					)}
					{!editing ? (
						<div>
							<Button variant="outline" onClick={() => setEditing(true)}>
								Create a skill
							</Button>
						</div>
					) : (
						<SkillForm
							heading="New skill"
							existing={existing}
							onSave={(target, text) => save(target, text, null)}
							onCancel={() => setEditing(false)}
						/>
					)}
				</>
			) : accepted === undefined ? (
				<p className="text-ui text-ink-2">
					No skill named /{name} is in effect. A SKILL.md in the workspace is in effect as soon as it parses; one that
					does not is below, with what is wrong.
				</p>
			) : (
				<SkillDetail skill={accepted} showTitle={false} />
			)}
			{name !== undefined && selected?.change !== undefined ? (
				<ChangeReview
					isNew={accepted === undefined}
					change={selected.change}
					onAccept={(sha) =>
						void attempt("accept the skill", async () => {
							await acceptSkill(name, sha);
							await reload();
							changed();
						})
					}
				/>
			) : null}
			{name !== undefined && accepted !== undefined && !editing ? (
				<div>
					<Button variant="outline" onClick={() => setEditing(true)}>
						Edit instructions
					</Button>
				</div>
			) : null}
			{name !== undefined && accepted !== undefined && editing ? (
				<SkillForm
					heading={`Edit /${name}`}
					name={name}
					initialText={accepted.text}
					existing={[]}
					onSave={(target, text) => save(target, text, accepted.sha)}
					onCancel={() => setEditing(false)}
				/>
			) : null}
		</SettingsPage>
	);
}

/** A workspace version that is not in effect: one that does not read, says why; one that does, the owner may accept. */
function ChangeReview({
	isNew,
	change,
	onAccept,
}: {
	isNew: boolean;
	change: NonNullable<SkillView["change"]>;
	onAccept: (sha: string) => void;
}) {
	return (
		<section className="flex flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-4">
			<h2 className="text-ui font-semibold">
				{change.kind === "removed"
					? "An agent removed this skill's file"
					: isNew
						? "An agent wrote this skill"
						: "An agent changed this skill"}
			</h2>
			{change.kind === "removed" ? (
				<p className="text-ui text-ink-2">The version you accepted still works. There is nothing to allow.</p>
			) : (
				<>
					<p className="text-ui text-ink-2">Review it before agents use it.</p>
					<p className="text-meta text-ink-2">
						{isNew ? "New skill · agents don't use it yet" : "Proposed version · agents don't use it yet"}
					</p>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-field bg-paper p-3 font-mono text-meta">
						{change.text ?? change.errors?.join("\n")}
					</pre>
					{change.errors !== undefined ? <p className="text-ui text-danger">{change.errors.join("\n")}</p> : null}
					{change.sha !== undefined && change.errors === undefined ? (
						<Button onClick={() => onAccept(change.sha ?? "")}>Accept this version</Button>
					) : null}
				</>
			)}
		</section>
	);
}

/** The skills banda ships and the workspace lacks: one tap writes and accepts one, as at first run. */
export function FromBanda({
	offers,
	busy,
	onAdd,
}: {
	offers: readonly { readonly name: string; readonly about: string; readonly note?: string }[];
	busy?: string;
	onAdd: (name: string) => void;
}) {
	if (offers.length === 0) return null;
	return (
		<section aria-label="Skills from banda" className="flex flex-col gap-3">
			<header className="flex flex-col gap-0.5">
				<h2 className="text-ui font-semibold text-ink">From banda</h2>
				<p className="text-meta text-ink-2">Ready-made skills. Add one and agents can use it right away.</p>
			</header>
			<ul className="flex min-w-0 flex-col divide-y divide-line-soft rounded-tile border border-line-soft">
				{offers.map((offer) => (
					<li key={offer.name} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate font-mono text-ui font-medium text-ink">/{offer.name}</span>
							<span className="text-meta text-ink-2">{offer.about}</span>
							{offer.note === undefined ? null : <span className="text-meta text-ink-2">{offer.note}</span>}
						</span>
						<Button
							variant="outline"
							size="sm"
							disabled={busy !== undefined}
							aria-label={`Add /${offer.name}`}
							onClick={() => onAdd(offer.name)}
						>
							{busy === offer.name ? "Adding…" : "Add"}
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}

const TEMPLATE = (name: string) =>
	`---\nname: ${name}\ndescription: What this skill helps with\n---\n\n# Instructions\n`;

/**
 * The SKILL.md editor, for a new skill or an accepted one. It says what the daemon would refuse while the owner
 * types, and "Save and use" stays off until the file would be taken: the owner's own save is accepted at once.
 */
export function SkillForm({
	heading,
	name,
	initialName,
	initialText,
	existing,
	onSave,
	onCancel,
}: {
	heading: string;
	/** Set on an edit: the name is fixed. */
	name?: string;
	/** A create's starting name, for a prefilled form. */
	initialName?: string;
	initialText?: string;
	/** Names already in the workspace: a new skill cannot take one. */
	existing: readonly string[];
	onSave: (name: string, text: string) => Promise<unknown>;
	onCancel: () => void;
}) {
	const create = name === undefined;
	const [typed, setTyped] = useState(initialName ?? "");
	const [text, setText] = useState(initialText ?? "");
	const [saving, setSaving] = useState(false);
	const target = name ?? typed;
	const state = skillFormState({ name: target, text, existing: create ? existing : [] });
	// the name's own verdicts show at the name field; down here only the file's
	const fileProblems = state.problems.filter(
		(problem) => problem !== NAME_RULE && problem !== `A skill called /${target} already exists.`,
	);
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-ui font-semibold">{heading}</h2>
			{create ? (
				<div className="flex flex-col gap-1">
					<Input
						aria-label="Skill name"
						aria-invalid={state.badName || state.taken}
						placeholder="name"
						value={typed}
						onChange={(event) => {
							const value = event.target.value.toLowerCase();
							const fresh = text === "" || text === TEMPLATE(typed);
							setTyped(value);
							if (fresh) setText(TEMPLATE(value));
						}}
					/>
					<p className={`text-meta ${state.badName ? "text-danger" : "text-ink-2"}`}>{NAME_RULE}</p>
					{state.taken ? (
						<p role="alert" className="text-meta text-danger">
							A skill called /{target} already exists.
						</p>
					) : typed === "" ? null : state.badName ? null : (
						<p className="text-meta text-ink-2">
							In a chat: <span className="font-mono text-ink">/{target}</span>
						</p>
					)}
				</div>
			) : null}
			<Textarea
				aria-label="SKILL.md"
				className="min-h-64 font-mono"
				value={text}
				onChange={(event) => setText(event.target.value)}
			/>
			<div className="flex flex-col gap-1">
				<p className="text-meta text-ink-2">
					{state.description === ""
						? "The description tells agents when this skill fits. 1 to 1,024 characters."
						: `Description · ${state.description.length} of 1,024 characters`}
				</p>
				{state.size === undefined ? null : (
					<p className={`text-meta ${state.overSize ? "text-danger" : "text-ink-2"}`}>{state.size}</p>
				)}
				{fileProblems.length > 0 ? (
					<p role="alert" className="text-meta text-danger">
						{fileProblems.join(" ")}
					</p>
				) : null}
			</div>
			<div className="flex gap-2">
				<Button
					disabled={!state.valid || saving}
					onClick={() => {
						setSaving(true);
						void onSave(target, text).finally(() => setSaving(false));
					}}
				>
					Save and use
				</Button>
				<Button variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</section>
	);
}

/**
 * Proposed skills the owner has not accepted: each opens to its review, and the ones that parse are accepted together,
 * at exactly the versions listed here.
 */
export function Waiting({
	list,
	onOpen,
	reload,
}: {
	list: readonly SkillView[];
	onOpen: (name: string) => void;
	reload: () => Promise<void>;
}) {
	const waiting = list.filter(waitsOnOwner);
	if (waiting.length === 0) return null;
	const ready = waiting.flatMap(({ name, change }) =>
		change?.sha !== undefined && change.errors === undefined ? [{ name, sha: change.sha }] : [],
	);
	return (
		<section
			aria-label="Skills waiting for review"
			className="flex flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-4"
		>
			<h2 className="text-ui font-semibold">
				{waiting.length === 1 ? "1 skill is" : `${waiting.length} skills are`} waiting for your review
			</h2>
			<p className="text-meta text-ink-2">
				Agents can't use these yet: a file that doesn't read needs fixing in the workspace; one that does is in effect
				once you accept it.
			</p>
			<ul className="flex max-h-80 flex-col gap-1 overflow-auto">
				{waiting.map(({ name, change }) => (
					<li key={name} className="flex min-w-0 items-baseline gap-2">
						<button
							type="button"
							className="truncate font-mono text-ui font-medium text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink"
							onClick={() => onOpen(name)}
						>
							/{name}
						</button>
						<span className="shrink-0 text-meta text-ink-2">
							{change?.errors !== undefined ? "can't be read" : change?.kind === "changed" ? "changed" : "new"}
						</span>
					</li>
				))}
			</ul>
			{ready.length > 0 ? (
				<Button
					onClick={() =>
						void attempt("accept the skills", async () => {
							await acceptSkills(ready);
							await reload();
							changed();
						})
					}
				>
					{ready.length === 1 ? "Accept 1 skill" : `Accept all ${ready.length} skills`}
				</Button>
			) : null}
		</section>
	);
}
