/**
 * First run, after the provider: the skills banda ships, each with a switch. The ones on are added to the workspace,
 * accepted, when the owner goes on; Skip adds none. One already in the workspace stays as it is.
 */
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { Face } from "./Face.tsx";

const FIRST_FACE = defaultAvatarFace();

export type SkillOffer = {
	readonly name: string;
	/** What it is for, in the owner's words. */
	readonly about: string;
	/** What else to know before taking it, such as a request it makes. */
	readonly note?: string | undefined;
	/** In the workspace already: left as it is. */
	readonly added: boolean;
};

export function FirstSkills({
	skills,
	picked,
	busy = false,
	error,
	onToggle,
	onAdd,
	onSkip,
}: {
	skills: readonly SkillOffer[];
	/** The names switched on. */
	picked: ReadonlySet<string>;
	/** The choice is being saved. */
	busy?: boolean;
	error?: string | undefined;
	onToggle?: (name: string, on: boolean) => void;
	onAdd?: () => void;
	onSkip?: () => void;
}) {
	const adding = skills.filter((skill) => !skill.added && picked.has(skill.name)).length;
	return (
		<div className="flex h-full flex-col items-center overflow-y-auto bg-paper px-4 py-12">
			<div className="flex w-full max-w-sm shrink-0 flex-col items-center gap-3 text-center">
				<Face face={FIRST_FACE} name="Sancho" size="hero" />
				<h1 className="mt-2 text-display font-semibold text-ink">Skills to start with</h1>
				<p className="text-body text-ink-2">
					A skill is a way of working the band can follow. Type <span className="font-mono">/name</span> in a chat to
					use one.
				</p>
			</div>
			<ul className="mt-8 flex w-full max-w-sm shrink-0 flex-col divide-y divide-line-soft overflow-hidden rounded-tile border border-line-soft">
				{skills.map((skill) => {
					const id = `first-skill-${skill.name}`;
					return (
						<li key={skill.name}>
							<label htmlFor={id} className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-3">
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="font-mono text-ui font-medium text-ink">/{skill.name}</span>
									<span className="text-meta text-ink-2">{skill.about}</span>
									{skill.added ? (
										<span className="text-meta text-ink-2">In your workspace already</span>
									) : skill.note === undefined ? null : (
										<span className="text-meta text-ink-2">{skill.note}</span>
									)}
								</span>
								<Switch
									id={id}
									checked={skill.added || picked.has(skill.name)}
									disabled={skill.added || busy}
									onCheckedChange={(on) => onToggle?.(skill.name, on)}
								/>
							</label>
						</li>
					);
				})}
			</ul>
			{error === undefined ? null : (
				<p role="alert" className="mt-4 max-w-sm text-center text-ui text-danger">
					{error}
				</p>
			)}
			<div className="mt-6 flex w-full max-w-sm shrink-0 flex-col gap-2">
				<Button size="lg" disabled={busy} onClick={() => onAdd?.()}>
					{adding === 0 ? "Go on" : adding === 1 ? "Add 1 skill" : `Add ${adding} skills`}
				</Button>
				{adding === 0 ? null : (
					<Button variant="ghost" disabled={busy} onClick={() => onSkip?.()}>
						Skip
					</Button>
				)}
			</div>
			<p className="mt-4 max-w-sm text-center text-meta text-ink-2">
				You can read and change them later on the Skills page.
			</p>
		</div>
	);
}
