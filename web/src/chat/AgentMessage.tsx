/**
 * A message between this chat's agent and another agent, as a centred feed line: the other agent, and whether it sent
 * or was sent to. The line is a link: it opens what the two said to each other (the exchange), at this message.
 */
import { MessageCircleIcon } from "lucide-react";
import { Face } from "./Face.tsx";
import type { Who } from "./types.ts";

export function AgentMessage({
	other,
	direction,
	href,
	time,
}: {
	/** The other agent: the sender of a message that came in, the recipient of one that went out. */
	other: Who & { readonly id: string };
	direction: "in" | "out";
	/** The exchange between the two, at this message. */
	href: string;
	time?: string | undefined;
}) {
	const face = <Face face={other.face} name={other.name} size="mention" />;
	const name = <span className="font-medium text-ink">{other.name}</span>;
	return (
		<div className="mx-auto flex w-full max-w-[var(--measure)] justify-center px-4 text-ui text-ink-2">
			<div className="flex w-fit max-w-full flex-wrap items-center justify-center gap-x-1.5">
				<MessageCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
				<a
					href={href}
					data-agent-message={direction}
					className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 rounded-field hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ring"
				>
					{direction === "in" ? (
						<>
							{face}
							{name}
							<span>sent a message</span>
						</>
					) : (
						<>
							<span>Messaged</span>
							{face}
							{name}
						</>
					)}
				</a>
				{time === undefined ? null : <span className="shrink-0 text-meta text-ink-2">{time}</span>}
			</div>
		</div>
	);
}
