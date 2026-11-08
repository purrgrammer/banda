import { PaperclipIcon } from "lucide-react";
import { useId } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { sizeOf } from "../lib/size.ts";

/** The exact email the owner is about to send, in an editable, readable form. */
export function EmailDraftPreview({
	args,
	edits,
	readOnly,
	onEdit,
}: {
	args: Record<string, unknown>;
	edits: Record<string, string>;
	readOnly: boolean;
	onEdit: (name: string, value: string) => void;
}) {
	const id = useId();
	const value = (name: string) => edits[name] ?? (typeof args[name] === "string" ? (args[name] as string) : "");
	const seen = new Map<string, number>();
	const attachments = Array.isArray(args.attachments)
		? args.attachments.flatMap((entry) => {
				if (typeof entry !== "object" || entry === null) return [];
				const file = entry as Record<string, unknown>;
				if (typeof file.name !== "string") return [];
				const name = file.name.slice(0, 120);
				const identity = typeof file.sha === "string" ? file.sha : name;
				const occurrence = seen.get(identity) ?? 0;
				seen.set(identity, occurrence + 1);
				return [
					{ key: `${identity}:${occurrence}`, name, size: typeof file.size === "number" ? file.size : undefined },
				];
			})
		: [];
	return (
		<section
			aria-label="Email draft preview"
			className="flex min-w-0 flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-3.5"
		>
			<p className="text-meta font-medium text-ink-2">Email draft</p>
			<Field className="min-w-0 gap-1">
				<FieldLabel htmlFor={`${id}-to`}>To</FieldLabel>
				<Input
					id={`${id}-to`}
					aria-label="Email recipient"
					value={value("to")}
					readOnly={readOnly}
					onChange={(event) => onEdit("to", event.target.value)}
				/>
			</Field>
			<Field className="min-w-0 gap-1">
				<FieldLabel htmlFor={`${id}-subject`}>Subject</FieldLabel>
				<Input
					id={`${id}-subject`}
					aria-label="Email subject"
					value={value("subject")}
					readOnly={readOnly}
					onChange={(event) => onEdit("subject", event.target.value)}
				/>
			</Field>
			<Field className="min-w-0 gap-1">
				<FieldLabel htmlFor={`${id}-body`}>Message</FieldLabel>
				<Textarea
					id={`${id}-body`}
					aria-label="Email body"
					value={value("body")}
					readOnly={readOnly}
					className="min-h-32 bg-paper text-body"
					onChange={(event) => onEdit("body", event.target.value)}
				/>
			</Field>
			{attachments.length === 0 ? null : (
				<div className="flex flex-col gap-1.5 border-t border-line-soft pt-2">
					<p className="text-meta text-ink-2">Attachments</p>
					{attachments.map((file) => (
						<div key={file.key} className="flex min-w-0 items-center gap-2 text-meta text-ink">
							<PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-2" />
							<span className="min-w-0 flex-1 truncate" title={file.name}>
								{file.name}
							</span>
							{file.size === undefined ? null : <span className="shrink-0 text-ink-2">{sizeOf(file.size)}</span>}
						</div>
					))}
				</div>
			)}
		</section>
	);
}
