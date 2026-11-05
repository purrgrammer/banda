/**
 * First run (DESIGN.md "The app"): while no provider the band thinks with is connected, the first agent's screen with
 * the providers to pick from. A provider with a sign-in opens it in a tab of its own (opened from the tap, so it is
 * not blocked) and this screen waits for it, takes the code its page shows when the page never comes back, or cancels
 * it; picked again, it starts over. One without a sign-in takes a key. Then the skills banda ships, once; then the
 * band opens.
 */
import { useEffect, useState } from "react";
import { useProviderConnect, wayLabel } from "../areas/tiers.ts";
import { FirstRun } from "../chat/FirstRun.tsx";
import { FirstSkills } from "../chat/FirstSkills.tsx";
import { chooseShippedSkills, type ShippedSkillsView, shippedSkills } from "../lib/api.ts";

/** Providers whose own sign-in comes first; the rest follow in the daemon's order. */
const FIRST = ["anthropic", "openai", "github-copilot", "google"];

export function Onboarding() {
	const { providers, open, waiting, error, pick, answer, cancel, key } = useProviderConnect();
	const sorted = [...providers].sort((a, b) => (FIRST.indexOf(a.id) + 1 || 99) - (FIRST.indexOf(b.id) + 1 || 99));
	return (
		<FirstRun
			providers={sorted.map((provider) => ({
				id: provider.id,
				name: provider.name,
				by: provider.oauth ? ("sign-in" as const) : ("key" as const),
				...(provider.connected ? { note: "Connected · use it" } : {}),
				connecting: provider.connecting,
				asks: provider.question !== undefined,
				ways: provider.methods?.map((way) => ({ id: way.id, label: wayLabel(way) })),
				way: provider.method,
			}))}
			open={open}
			waiting={waiting}
			error={error}
			onPick={(id) => void pick(id)}
			onKey={(id, value) => void key(id, value)}
			onAnswer={(id, value) => void answer(id, value)}
			onWay={(id, way) => void pick(id, way)}
			onCancel={(id) => void cancel(id)}
		/>
	);
}

/**
 * The skills banda ships, as the daemon offers them: undefined while read, and `chosen` once the owner chose or
 * skipped (or the daemon could not say, so the app is never held on this step).
 */
export function useShippedSkills() {
	const [view, setView] = useState<ShippedSkillsView>();
	useEffect(() => {
		let gone = false;
		shippedSkills().then(
			(next) => {
				if (!gone) setView(next);
			},
			() => {
				if (!gone) setView({ chosen: true, skills: [] });
			},
		);
		return () => {
			gone = true;
		};
	}, []);
	return [view, setView] as const;
}

/** The skills step: those banda suggests start on; the owner's choice is saved, accepted, in one tap. */
export function SkillsOnboarding({
	view,
	onChosen,
}: {
	view: ShippedSkillsView;
	onChosen: (next: ShippedSkillsView) => void;
}) {
	const [picked, setPicked] = useState(
		() => new Set(view.skills.flatMap((skill) => (skill.byDefault && !skill.added ? [skill.name] : []))),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const choose = (names: readonly string[]) => {
		setBusy(true);
		setError(undefined);
		chooseShippedSkills(names).then(onChosen, (reason: unknown) => {
			setBusy(false);
			setError(`Couldn't add the skills: ${reason instanceof Error ? reason.message : String(reason)}. Try again.`);
		});
	};
	return (
		<FirstSkills
			skills={view.skills}
			picked={picked}
			busy={busy}
			error={error}
			onToggle={(name, on) =>
				setPicked((before) => {
					const next = new Set(before);
					if (on) next.add(name);
					else next.delete(name);
					return next;
				})
			}
			onAdd={() => choose(view.skills.flatMap((skill) => (!skill.added && picked.has(skill.name) ? [skill.name] : [])))}
			onSkip={() => choose([])}
		/>
	);
}
