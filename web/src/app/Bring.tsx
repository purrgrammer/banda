/**
 * Bringing skills and agents from the other harnesses on this computer (Claude Code, Codex, pi), in the desktop app
 * only: at first run in place of banda's own skills, and in Settings any time. A harness with nothing that could come
 * along is not offered. Each harness says how the band can hand it coding work (the harnesses view).
 */
import { useEffect, useState } from "react";
import {
	BringBlock,
	type BringHarness,
	type BringKind,
	bringWords,
	FirstBring,
	type PreviewRow,
	pickKey,
	preview,
} from "../chat/FirstBring.tsx";
import { Block } from "../chat/Settings.tsx";
import { api, type BringView, bringable, chooseBring, type HarnessesView } from "../lib/api.ts";
import { desktop } from "../lib/desktop.ts";
import { skillsChanged } from "./Skills.tsx";

type Found = { view: BringView; harnesses?: HarnessesView };

/** Read what there is to bring; undefined outside the desktop app or when the daemon could not say. */
async function find(): Promise<Found | undefined> {
	if (desktop === undefined) return undefined;
	const [found, harnesses] = await Promise.all([bringable(), api<HarnessesView>("/harnesses").catch(() => undefined)]);
	return { view: found, ...(harnesses === undefined ? {} : { harnesses }) };
}

const openItem = (item: { added: boolean; problem?: string | undefined }) => !item.added && item.problem === undefined;

/**
 * At first run: undefined while read, and `chosen` once the owner chose or started fresh, when there is nothing to
 * bring, outside the desktop app, or when the daemon could not say, so the app is never held on this step.
 */
export function useBring() {
	const [view, setView] = useState<Found>();
	useEffect(() => {
		let gone = false;
		const done = { view: { chosen: true, harnesses: [] } };
		find().then(
			(found) => {
				if (gone) return;
				const any = found?.view.harnesses.some((one) => [...one.skills, ...one.agents].some(openItem)) === true;
				setView(any && found !== undefined ? found : done);
			},
			() => {
				if (!gone) setView(done);
			},
		);
		return () => {
			gone = true;
		};
	}, []);
	return [view, setView] as const;
}

/** The harnesses as the picker shows them: marks and how each connects, those with nothing to bring left out. */
function shownOf(view: BringView, harnesses: HarnessesView | undefined): BringHarness[] {
	return view.harnesses.flatMap((one) => {
		if (![...one.skills, ...one.agents].some(openItem)) return [];
		const installed = harnesses?.harnesses.find((each) => each.name === one.name);
		const missing = harnesses?.missing.find((each) => each.name === one.name);
		const mark = installed ?? missing;
		return [
			{
				...one,
				provider: mark?.provider,
				logo: mark?.logo,
				connect:
					harnesses?.accounts[one.name] !== undefined
						? undefined
						: installed !== undefined
							? "ready"
							: missing?.install === undefined
								? undefined
								: { install: missing.install },
			},
		];
	});
}

/** The picker's state: no harness picked at first; picking one brings everything it can, any of it left behind. */
function usePicker(view: BringView, harnesses: HarnessesView | undefined) {
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const shown = shownOf(view, harnesses);
	const toggle = (set: typeof setPicked, key: string, on: boolean) =>
		set((before) => {
			const next = new Set(before);
			if (on) next.add(key);
			else next.delete(key);
			return next;
		});
	/** Bring `rows` that are on; `then` gets the daemon's view and whether anything came. */
	const bring = (rows: readonly PreviewRow[], then: (next: BringView, brought: string) => void) => {
		const of = (kind: BringKind) =>
			rows.flatMap((row) => (row.kind === kind && row.on ? [{ harness: row.harness.name, name: row.item.name }] : []));
		const words = bringWords(rows);
		setBusy(true);
		setError(undefined);
		chooseBring(of("skills"), of("agents")).then(
			(next) => {
				setBusy(false);
				setPicked(new Set());
				setLeft(new Set());
				if (words !== "") skillsChanged();
				then(next, words);
			},
			(reason: unknown) => {
				setBusy(false);
				setError(`Couldn't bring them: ${reason instanceof Error ? reason.message : String(reason)}. Try again.`);
			},
		);
	};
	return {
		props: {
			harnesses: shown,
			picked,
			left,
			busy,
			error,
			onHarness: (harness: string, on: boolean) => toggle(setPicked, harness, on),
			onItem: (kind: BringKind, name: string, on: boolean) => toggle(setLeft, pickKey(kind, name), !on),
		},
		rows: () => preview(shown, picked, left),
		bring,
	};
}

/** At first run, in place of banda's own skills: `brought` says whether anything came; if not, they come next. */
export function BringOnboarding({
	view,
	harnesses,
	onChosen,
}: {
	view: BringView;
	harnesses?: HarnessesView | undefined;
	onChosen: (next: BringView, brought: boolean) => void;
}) {
	const { props, rows, bring } = usePicker(view, harnesses);
	return (
		<FirstBring
			{...props}
			onBring={() => bring(rows(), (next, words) => onChosen(next, words !== ""))}
			onFresh={() => bring([], (next) => onChosen(next, false))}
		/>
	);
}

/** In Settings, desktop only: null elsewhere, and until read. */
export function BringSettings() {
	const [found, setFound] = useState<Found>();
	const [done, setDone] = useState<string>();
	useEffect(() => {
		let gone = false;
		find().then(
			(next) => {
				if (!gone) setFound(next);
			},
			() => {},
		);
		return () => {
			gone = true;
		};
	}, []);
	if (found === undefined) return null;
	return (
		<BringSettingsBlock
			found={found}
			done={done}
			onBrought={(next, words) => {
				setFound({ ...found, view: next });
				setDone(words);
			}}
		/>
	);
}

function BringSettingsBlock({
	found,
	done,
	onBrought,
}: {
	found: Found;
	done: string | undefined;
	onBrought: (next: BringView, words: string) => void;
}) {
	const { props, rows, bring } = usePicker(found.view, found.harnesses);
	return (
		<Block
			title="Bring skills and agents"
			note="Copy them from the other coding agents on this computer; the originals stay where they are."
		>
			<BringBlock {...props} done={done} onBring={() => bring(rows(), onBrought)} />
		</Block>
	);
}
