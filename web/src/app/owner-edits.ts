import type { Edit } from "./edit-file.ts";

/** Per-agent debounce and serialization: navigating to another agent never discards an owner's edit. */
export function ownerEdits(save: (agent: string, edit: Edit) => Promise<unknown>) {
	const pending = new Map<
		string,
		{
			timer?: ReturnType<typeof setTimeout>;
			edit: Edit;
			saving: Promise<unknown>;
		}
	>();
	return (agent: string, edit: Edit, immediate = false) => {
		let entry = pending.get(agent);
		if (!entry) {
			entry = { edit: {}, saving: Promise.resolve() };
			pending.set(agent, entry);
		}
		const current = entry;
		current.edit = { ...current.edit, ...edit };
		if (Object.keys(current.edit).length === 0) return;
		clearTimeout(current.timer);
		const flush = () => {
			const next = current.edit;
			current.edit = {};
			// The caller reports failures. A failed write must not prevent a later owner edit.
			current.saving = current.saving.then(() => save(agent, next)).catch(() => {});
		};
		if (immediate) flush();
		else current.timer = setTimeout(flush, 800);
	};
}
