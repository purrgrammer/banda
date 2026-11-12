/**
 * Text an agent wrote that the owner may edit before accepting it (DESIGN.md "Drafts"): a comment, a pull request's
 * title, an agent's personality, what a routine asks. It reads as a block with a quiet Edit that turns it into a field;
 * once changed it says "Edited by you", and Undo puts back what the agent wrote. Only text: an order for a machine (a
 * command, a diff, a held request) never comes here.
 */
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../lib/cn.ts";

export const EDITED_WORDS = "Edited by you";

export function EditableText({
	label,
	value,
	original,
	onChange,
	disabled = false,
	line = false,
	reads,
	hint,
	invalid,
	children,
}: {
	/** What it is, as the card names it: "What will be sent", "Title", "Instructions". */
	label: string;
	/** The text as it stands: the owner's, when they edited it. */
	value: string;
	/** What the agent wrote: an edit is any difference from it. */
	original: string;
	/** Absent: it reads only (answered, or not the owner's to edit). */
	onChange?: ((value: string) => void) | undefined;
	disabled?: boolean | undefined;
	/** One line (a title, a schedule), not a block. */
	line?: boolean | undefined;
	/** How it reads when it is not being edited, when not the text itself: a schedule line in words. */
	reads?: string | undefined;
	/** A line under the field while it is edited: what it takes. */
	hint?: string | undefined;
	/** Why the text as edited cannot be accepted, under the field; the card's button holds back meanwhile. */
	invalid?: string | undefined;
	/** Under the text, whether it reads or is edited: a warning about what it says. */
	children?: ReactNode;
}) {
	const id = useId();
	const [editing, setEditing] = useState(false);
	const edited = value !== original;
	const open = editing && onChange !== undefined;
	return (
		<div className="flex flex-col gap-1.5" data-edited={edited ? "" : undefined}>
			<div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-0.5">
				<label htmlFor={open ? id : undefined} className="text-meta font-medium text-ink-2">
					{label}
				</label>
				{edited ? <span className="text-meta text-ink-2">· {EDITED_WORDS}</span> : null}
				{onChange === undefined ? null : (
					<span className="ms-auto flex items-center gap-1">
						{edited && !open ? (
							<Button variant="ghost" size="xs" disabled={disabled} onClick={() => onChange(original)}>
								Undo
							</Button>
						) : null}
						<Button
							variant="ghost"
							size="xs"
							disabled={disabled}
							aria-expanded={open}
							aria-label={open ? `Done editing ${label.toLowerCase()}` : `Edit ${label.toLowerCase()}`}
							onClick={() => setEditing(!open)}
						>
							{open ? "Done" : "Edit"}
						</Button>
					</span>
				)}
			</div>
			{open ? (
				line ? (
					<Input
						id={id}
						value={value}
						disabled={disabled}
						autoFocus
						aria-invalid={invalid === undefined ? undefined : true}
						onChange={(event) => onChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === "Escape") setEditing(false);
						}}
					/>
				) : (
					<Textarea
						id={id}
						value={value}
						disabled={disabled}
						autoFocus
						aria-invalid={invalid === undefined ? undefined : true}
						className="min-h-24"
						onChange={(event) => onChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setEditing(false);
						}}
					/>
				)
			) : (
				<p
					className={cn(
						"rounded-field bg-paper-3/60 px-3 py-2 text-body text-ink [overflow-wrap:anywhere]",
						line ? "" : "max-h-72 overflow-auto whitespace-pre-wrap",
					)}
				>
					{value === "" ? <span className="text-ink-2">Empty</span> : (reads ?? value)}
				</p>
			)}
			{invalid !== undefined ? (
				<p role="alert" className="text-meta text-danger">
					{invalid}
				</p>
			) : open && hint !== undefined ? (
				<p className="text-meta text-ink-2">{hint}</p>
			) : null}
			{children}
		</div>
	);
}
