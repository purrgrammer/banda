/** A direct message from another agent: a centered feed line with its body hidden until opened. */
import { MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import { Face } from "./Face.tsx";
import type { Who } from "./types.ts";

export function AgentMessage({
	author,
	text,
	time,
}: {
	author: Who & { readonly id: string };
	text: string;
	time?: string | undefined;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="mx-auto flex w-full max-w-[var(--measure)] justify-center px-4 text-ui text-ink-2">
			<div className="w-fit max-w-full">
				<div className="flex flex-wrap items-center justify-center gap-x-1.5">
					<MessageCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
					<Face face={author.face} name={author.name} size="mention" />
					<a
						href={`#/a/${encodeURIComponent(author.id)}`}
						className="rounded-field font-medium text-ink hover:underline"
					>
						{author.name}
					</a>
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setOpen((shown) => !shown)}
						className="rounded-field text-left hover:text-ink"
					>
						sent a message
					</button>
					{time === undefined ? null : <span className="shrink-0 text-meta text-ink-2">{time}</span>}
				</div>
				{open ? (
					<button
						type="button"
						aria-label={`Hide message from ${author.name}`}
						onClick={() => setOpen(false)}
						className="mx-auto mt-1 block w-fit max-w-[min(calc(100vw-2rem),32rem)] whitespace-pre-wrap text-center [overflow-wrap:anywhere] hover:text-ink"
					>
						{text}
					</button>
				) : null}
			</div>
		</div>
	);
}
