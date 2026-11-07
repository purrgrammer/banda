/**
 * The keyboard (DESIGN.md "Keyboard"): Enter sends, Cmd/Ctrl+K searches, Cmd/Ctrl+1 to 9 open the band's rows, Alt+↑
 * and Alt+↓ the chat above or below, Esc closes the panel or a sheet; "?" lists them, in a dialog of their own.
 */
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { MOD } from "@/lib/keys";

/** Each shortcut: its keys, and what it does in words. */
export const SHORTCUTS: readonly (readonly [readonly string[], string])[] = [
	[["Enter"], "Send"],
	[["Shift", "Enter"], "A new line"],
	[[MOD, "K"], "Search banda"],
	[[MOD, "1–9"], "Open a chat of the band, top to bottom"],
	[["Alt", "↑"], "The chat above"],
	[["Alt", "↓"], "The chat below"],
	[["Esc"], "Close the panel, a sheet or a dialog"],
	[["?"], "These shortcuts"],
];

/** Whether a key went to something the owner types in: there a "?" is a question mark. */
export const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]") !== null;

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm gap-3 bg-paper p-5">
				<DialogTitle className="text-heading font-semibold text-ink">Keyboard shortcuts</DialogTitle>
				<DialogDescription className="sr-only">The keys banda answers to, and what each does</DialogDescription>
				<ShortcutList />
			</DialogContent>
		</Dialog>
	);
}

/** The shortcuts, a row each: what it does, and its keys. */
export function ShortcutList() {
	return (
		<dl className="flex flex-col">
			{SHORTCUTS.map(([keys, what]) => (
				<div
					key={what}
					className="flex items-center justify-between gap-4 border-b border-line-soft py-2 last:border-0"
				>
					<dt className="text-ui text-ink">{what}</dt>
					<dd className="flex shrink-0 gap-1">
						{keys.map((key) => (
							<kbd
								key={key}
								className="inline-flex h-6 min-w-6 items-center justify-center rounded-[6px] border border-line bg-paper-2 px-1.5 font-text text-meta text-ink-2"
							>
								{key}
							</kbd>
						))}
					</dd>
				</div>
			))}
		</dl>
	);
}
