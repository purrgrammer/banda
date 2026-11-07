/** Shared skills, from the accepted workspace files. Draft box changes never appear as usable instructions. */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPage } from "../chat/Settings.tsx";
import { SkillCatalogue, SkillDetail } from "../chat/Skill.tsx";
import { acceptSkill, acceptSkills, type SkillView, saveSkill, skills } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";

const CHANGED = "banda.skills-changed";

export function useSkills() {
	const [list, setList] = useState<SkillView[]>([]);
	const reload = useCallback(async () => {
		setList(await skills());
	}, []);
	useEffect(() => {
		void reload().catch(() => {});
		const timer = setInterval(() => {
			void reload().catch(() => {});
		}, 15_000);
		addEventListener(CHANGED, reload);
		return () => {
			clearInterval(timer);
			removeEventListener(CHANGED, reload);
		};
	}, [reload]);
	return { list, reload };
}

const changed = () => dispatchEvent(new Event(CHANGED));
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
	const [newName, setNewName] = useState("");
	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState(false);
	const selected = list.find((item) => item.name === name);
	const accepted = selected?.accepted;
	const base = accepted?.sha ?? null;
	const create = name === undefined && editing;
	const edit = name !== undefined && editing;
	const target = create ? newName : (name ?? "");
	const save = () =>
		void attempt("save the skill", async () => {
			await saveSkill(target, draft, base);
			setEditing(false);
			setDraft("");
			await reload();
			changed();
			if (create) onOpen(target);
		});
	return (
		<SettingsPage
			title={name === undefined ? "Skills" : `/${name}`}
			phone={phone}
			onBack={onBack}
			wide={name !== undefined}
		>
			{name === undefined ? (
				<>
					<p className="text-ui text-ink-2">
						Shared with every agent. Use /name in a message, or let an agent load one when its work fits.
					</p>
					<SkillCatalogue
						skills={list.flatMap(({ accepted }) =>
							accepted === undefined ? [] : [{ name: accepted.name, description: accepted.description }],
						)}
						hrefFor={(value) => `#/skills/${value}`}
					/>
					<Waiting list={list} onOpen={onOpen} reload={reload} />
					{!editing ? (
						<Button
							variant="outline"
							onClick={() => {
								setDraft("");
								setEditing(true);
							}}
						>
							Create a skill
						</Button>
					) : null}
				</>
			) : accepted === undefined ? (
				<p className="text-ui text-ink-2">
					No accepted skill named /{name}. A proposed file needs review before it can load.
				</p>
			) : (
				<SkillDetail skill={accepted} />
			)}
			{selected?.change !== undefined ? (
				<section className="flex flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-4">
					<h2 className="text-ui font-semibold">A change in the box needs your review</h2>
					{selected.change.kind === "removed" ? (
						<p className="text-ui text-ink-2">
							The file was removed in the box. The accepted instructions remain available.
						</p>
					) : (
						<>
							<p className="text-meta text-ink-2">Proposed SKILL.md · {selected.change.kind} · not used by agents</p>
							<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-field bg-paper p-3 font-mono text-meta">
								{selected.change.text ?? selected.change.errors?.join("\n")}
							</pre>
							{selected.change.errors !== undefined ? (
								<p className="text-ui text-danger">{selected.change.errors.join("\n")}</p>
							) : null}
							{selected.change.sha !== undefined && selected.change.errors === undefined ? (
								<Button
									onClick={() =>
										void attempt("accept the skill", async () => {
											await acceptSkill(name ?? "", selected.change?.sha ?? "");
											await reload();
											changed();
										})
									}
								>
									Accept this version
								</Button>
							) : null}
						</>
					)}
				</section>
			) : null}
			{(create || (name !== undefined && !editing)) && name !== undefined && accepted !== undefined ? (
				<Button
					variant="outline"
					onClick={() => {
						setDraft(accepted.text);
						setEditing(true);
					}}
				>
					Edit instructions
				</Button>
			) : null}
			{create || edit ? (
				<section className="flex flex-col gap-3">
					<h2 className="text-ui font-semibold">{create ? "New skill" : `Edit /${name}`}</h2>
					{create ? (
						<Input
							aria-label="Skill name"
							placeholder="name"
							value={newName}
							onChange={(event) => {
								const value = event.target.value.toLowerCase();
								setNewName(value);
								setDraft(`---\nname: ${value}\ndescription: What this skill helps with\n---\n\n# Instructions\n`);
							}}
						/>
					) : null}
					<Textarea
						aria-label="SKILL.md"
						className="min-h-64 font-mono"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<div className="flex gap-2">
						<Button onClick={save} disabled={!target || !draft}>
							Save and use
						</Button>
						<Button variant="ghost" onClick={() => setEditing(false)}>
							Cancel
						</Button>
					</div>
				</section>
			) : null}
		</SettingsPage>
	);
}

/**
 * Proposed skills the owner has not accepted: each opens to its review, and the ones that parse are accepted together,
 * at exactly the versions listed here.
 */
function Waiting({
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
			<p className="text-meta text-ink-2">Agents can't load these until you accept them.</p>
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
