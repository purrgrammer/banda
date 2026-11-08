/** The Drive changes a draft may be, by the tool's own name. */
export const DRIVE_DRAFT = /^drive__(create_doc|create_sheet|replace_doc_text|rename_file|trash_file)$/;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const LINES = 8;

/**
 * A Drive change, as the owner approves it: read-only, because they approve exactly what was drafted. The title, how
 * much text, and its first lines as plain text (never rendered as a page). The file it acts on is the card above it.
 */
export function DriveDraftPreview({ tool, args }: { tool: string; args: Record<string, unknown> }) {
	const kind = DRIVE_DRAFT.exec(tool)?.[1];
	const body = text(args.markdown) ?? text(args.csv);
	const facts: [string, string][] = [];
	if (text(args.title) !== undefined) facts.push(["Title", String(args.title)]);
	if (text(args.name) !== undefined) facts.push(["New name", String(args.name)]);
	if (body !== undefined) {
		const lines = body.split("\n").length;
		facts.push([
			kind === "create_sheet" ? "Rows" : "Text",
			`${body.length.toLocaleString("en")} characters, ${lines.toLocaleString("en")} ${lines === 1 ? "line" : "lines"}`,
		]);
	}
	const first = body === undefined ? "" : body.split("\n").slice(0, LINES).join("\n");
	const more = body !== undefined && body.split("\n").length > LINES;
	return (
		<section
			aria-label="File draft"
			className="flex min-w-0 flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-3.5"
		>
			<p className="text-meta font-medium text-ink-2">
				{kind === "create_doc"
					? "New Doc"
					: kind === "create_sheet"
						? "New Sheet"
						: kind === "replace_doc_text"
							? "New text for this Doc"
							: kind === "rename_file"
								? "Rename"
								: "Trash"}
			</p>
			{facts.length === 0 ? null : (
				<dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
					{facts.map(([name, said]) => (
						<div key={name} className="contents">
							<dt className="text-ink-2">{name}</dt>
							<dd className="text-ink [overflow-wrap:anywhere]">{said}</dd>
						</div>
					))}
				</dl>
			)}
			{first === "" ? null : (
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-field bg-paper p-2.5 text-meta text-ink [overflow-wrap:anywhere]">
					{first}
					{more ? "\n…" : ""}
				</pre>
			)}
		</section>
	);
}
