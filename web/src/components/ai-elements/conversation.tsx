/**
 * ai-elements' conversation (https://elements.ai-sdk.dev), vendored without the `ai` package: a log that follows the
 * newest while the reader is at the bottom, stays put when they scrolled up, and offers a way back down.
 */
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "@/lib/cn";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
	<StickToBottom
		className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)}
		initial="instant"
		resize="instant"
		role="log"
		{...props}
	/>
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
	<StickToBottom.Content className={cn("flex flex-col gap-4", className)} {...props} />
);

/** Back to the newest, while the reader is scrolled up: how many arrived meanwhile, when known. */
export const ConversationScrollButton = ({
	className,
	count,
	label = "Latest",
}: {
	className?: string;
	count?: number;
	label?: string;
}) => {
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();
	if (isAtBottom) return null;
	// a reader who asked for reduced motion gets there at once, not by a spring
	const jump = () =>
		void scrollToBottom(
			typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
				? "instant"
				: undefined,
		);
	return (
		<button
			type="button"
			onClick={jump}
			className={cn(
				"absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-paper px-3 text-meta font-medium text-ink shadow-composer",
				className,
			)}
		>
			<ArrowDownIcon className="size-3.5" />
			{count === undefined || count === 0 ? label : `${count} new`}
		</button>
	);
};

/** Scroll to the newest now: when the owner sends, whatever they were reading. */
export const useConversation = () => useStickToBottomContext();
