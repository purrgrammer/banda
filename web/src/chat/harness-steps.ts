/** A harness session's steps, and what the card says of them: kept apart from the card so they test without a browser. */

/** One step of a session, as the harness reported it. */
export type HarnessStep =
	| { readonly kind: "asked"; readonly text: string }
	| { readonly kind: "steered"; readonly text: string; readonly taken: boolean; readonly from?: "agent" }
	| { readonly kind: "read"; readonly path: string }
	| { readonly kind: "thought"; readonly text: string }
	| {
			readonly kind: "edit";
			readonly path: string;
			readonly added?: number;
			readonly removed?: number;
			readonly diff?: string;
	  }
	| { readonly kind: "run"; readonly command: string; readonly output?: string; readonly running?: boolean }
	| { readonly kind: "waiting"; readonly command: string }
	| { readonly kind: "decided"; readonly command: string; readonly allowed: boolean }
	| { readonly kind: "said"; readonly text: string };

/** The one line the card shows for a step: a verb and what it acted on. */
export function headlineOf(step: HarnessStep | undefined): { verb: string; object: string } {
	switch (step?.kind) {
		case "read":
			return { verb: "Reading", object: step.path };
		case "edit":
			return { verb: "Editing", object: step.path };
		case "run":
			return { verb: step.running === false ? "Ran" : "Running", object: step.command };
		case "waiting":
			return { verb: "Waiting on you:", object: step.command };
		case "thought":
			return { verb: "Thinking", object: "" };
		case "steered":
			return { verb: step.from === "agent" ? "Taking a follow-up" : "Taking your note", object: "" };
		case "decided":
			return { verb: step.allowed ? "Going on: you allowed" : "Going on: you denied", object: step.command };
		case "said":
			return { verb: "Writing", object: "" };
		default:
			return { verb: "Starting", object: "" };
	}
}

/**
 * Files it changed, counted once per path, with the lines added and removed across its edits: undefined counts once
 * any edit did not say, never a made-up zero.
 */
export function changesOf(steps: readonly HarnessStep[]): { files: number; added?: number; removed?: number } {
	const paths = new Set<string>();
	let added: number | undefined = 0;
	let removed: number | undefined = 0;
	for (const step of steps) {
		if (step.kind !== "edit") continue;
		paths.add(step.path);
		added = added === undefined || step.added === undefined ? undefined : added + step.added;
		removed = removed === undefined || step.removed === undefined ? undefined : removed + step.removed;
	}
	return {
		files: paths.size,
		...(added === undefined ? {} : { added }),
		...(removed === undefined ? {} : { removed }),
	};
}

/** One file it changed: its lines across every edit of it (undefined once an edit did not say), and their diffs in order. */
export type ChangedFile = {
	readonly path: string;
	readonly added?: number;
	readonly removed?: number;
	readonly diffs: readonly string[];
};

/** Every file it changed, once each, in the order it first changed them: what the owner reviews when it ends. */
export function changedFiles(steps: readonly HarnessStep[]): ChangedFile[] {
	const files = new Map<string, { added: number | undefined; removed: number | undefined; diffs: string[] }>();
	for (const step of steps) {
		if (step.kind !== "edit") continue;
		const file = files.get(step.path) ?? { added: 0, removed: 0, diffs: [] };
		file.added = file.added === undefined || step.added === undefined ? undefined : file.added + step.added;
		file.removed = file.removed === undefined || step.removed === undefined ? undefined : file.removed + step.removed;
		if (step.diff !== undefined) file.diffs.push(step.diff);
		files.set(step.path, file);
	}
	return [...files].map(([path, { added, removed, diffs }]) => ({
		path,
		...(added === undefined ? {} : { added }),
		...(removed === undefined ? {} : { removed }),
		diffs,
	}));
}

/** A step as the transcript draws it: alone, or a run of reads one after another, folded into one ("Read 12 files"). */
export type StepItem =
	| { readonly kind: "step"; readonly step: HarnessStep; readonly index: number }
	| { readonly kind: "reads"; readonly paths: readonly string[]; readonly index: number };

/** The steps, with each run of two or more reads in a row folded into one item; `index` is the first step's place. */
export function foldedSteps(steps: readonly HarnessStep[]): StepItem[] {
	const items: StepItem[] = [];
	steps.forEach((step, index) => {
		const last = items.at(-1);
		if (step.kind === "read" && last?.kind === "reads") {
			items[items.length - 1] = { ...last, paths: [...last.paths, step.path] };
			return;
		}
		if (step.kind === "read" && last?.kind === "step" && last.step.kind === "read") {
			items[items.length - 1] = { kind: "reads", paths: [last.step.path, step.path], index: last.index };
			return;
		}
		items.push({ kind: "step", step, index });
	});
	return items;
}

/**
 * A folder as a card has room for it: a long path by its last two parts ("…/code/demo"), the project being what tells
 * sessions apart; the whole path stays in its title.
 */
export function shortFolder(folder: string, max = 28): string {
	if (folder.length <= max) return folder;
	const parts = folder.split("/").filter((part) => part !== "");
	return parts.length <= 2 ? folder : `…/${parts.slice(-2).join("/")}`;
}
