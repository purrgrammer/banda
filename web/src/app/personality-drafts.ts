import type { AgentFileView, AgentView } from "../../../src/server/api.ts";

type Version = { readonly file: AgentFileView; readonly text: string };
type Status = { readonly kind: "clean" | "pending" | "saving" } | { readonly kind: "failed"; readonly message: string };

export type PersonalityDraft = {
	readonly text: string;
	readonly base: Version;
	readonly latest: Version;
	readonly status: Status;
};

type Save = (
	agent: string,
	base: AgentFileView,
	text: string,
) => Promise<{ readonly file: AgentFileView; readonly agents: readonly AgentView[] }>;

const CONFLICT = "A newer version was saved. Your changes are kept here. Review both before saving again.";

export function personalityDrafts(
	save: Save,
	failure: (error: unknown) => string,
	fileText: (agent: string, file: AgentFileView, words: string) => string,
) {
	const drafts = new Map<string, ReturnType<typeof create>>();

	function create(agent: string, file: AgentFileView, text: string, onSaved: (agents: readonly AgentView[]) => void) {
		let state: PersonalityDraft = { text, base: { file, text }, latest: { file, text }, status: { kind: "clean" } };
		let timer: ReturnType<typeof setTimeout> | undefined;
		let writing = false;
		let sent: string | undefined;
		const listeners = new Set<() => void>();
		const getSnapshot = () => state;
		const update = (next: PersonalityDraft) => {
			state = next;
			for (const listener of listeners) listener();
		};
		const schedule = () => {
			clearTimeout(timer);
			if (!writing && state.status.kind === "pending") timer = setTimeout(() => void flush(), 800);
		};
		const flush = async () => {
			if (writing || state.status.kind !== "pending") return;
			clearTimeout(timer);
			const base = state.base;
			const words = state.text;
			const latest = state.latest.file.sha;
			writing = true;
			sent = fileText(agent, base.file, words);
			update({ ...state, status: { kind: "saving" } });
			try {
				const saved = await save(agent, base.file, words);
				const current = getSnapshot();
				if (
					current.status.kind === "failed" ||
					(current.latest.file.sha !== latest && current.latest.file.sha !== saved.file.sha)
				) {
					update({ ...current, status: { kind: "failed", message: CONFLICT } });
					return;
				}
				const version = { file: saved.file, text: words };
				update({
					...state,
					base: version,
					latest: version,
					status: { kind: state.text === words ? "clean" : "pending" },
				});
				onSaved(saved.agents);
			} catch (error) {
				update({ ...state, status: { kind: "failed", message: failure(error) } });
			} finally {
				writing = false;
				sent = undefined;
				schedule();
			}
		};
		return {
			getSnapshot,
			subscribe(listener: () => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			receive(next: AgentFileView, words: string) {
				if (next.sha === state.latest.file.sha) return;
				const version = { file: next, text: words };
				if (writing && next.text === sent) {
					update({ ...state, latest: version });
				} else if (state.status.kind === "clean") {
					update({ text: words, base: version, latest: version, status: { kind: "clean" } });
				} else {
					clearTimeout(timer);
					update({ ...state, latest: version, status: { kind: "failed", message: CONFLICT } });
				}
			},
			edit(words: string) {
				update({
					...state,
					text: words,
					status:
						state.status.kind === "failed" || writing
							? state.status
							: { kind: words === state.base.text ? "clean" : "pending" },
				});
				schedule();
			},
			retry() {
				if (writing) return;
				update({ ...state, status: { kind: "pending" } });
				void flush();
			},
			chooseMine(reviewed: string) {
				if (writing) return;
				if (state.latest.file.sha !== reviewed) {
					update({ ...state, status: { kind: "failed", message: CONFLICT } });
					return;
				}
				update({ ...state, base: state.latest, status: { kind: "pending" } });
				void flush();
			},
		};
	}

	return {
		forAgent(agent: string, file: AgentFileView, text: string, onSaved: (agents: readonly AgentView[]) => void) {
			let draft = drafts.get(agent);
			if (draft === undefined) {
				draft = create(agent, file, text, onSaved);
				drafts.set(agent, draft);
			}
			return draft;
		},
	};
}

export type PersonalityDrafts = ReturnType<typeof personalityDrafts>;
