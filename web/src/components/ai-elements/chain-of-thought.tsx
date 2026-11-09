/** ai-elements ChainOfThought, adapted to banda's tokens and a single accessible collapsible root. */
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { ChevronDownIcon, DotIcon, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/cn";

export function ChainOfThought({
	open,
	defaultOpen = false,
	onOpenChange,
	className,
	...props
}: ComponentProps<typeof Collapsible>) {
	const [isOpen, setIsOpen] = useControllableState({ prop: open, defaultProp: defaultOpen, onChange: onOpenChange });
	return (
		<Collapsible
			open={isOpen}
			onOpenChange={setIsOpen}
			className={cn("not-prose flex w-full flex-col gap-5", className)}
			{...props}
		/>
	);
}

export function ChainOfThoughtHeader({ children, className, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
	return (
		<CollapsibleTrigger
			className={cn("group flex w-full items-center gap-2 text-left text-ui text-ink-2 hover:text-ink", className)}
			{...props}
		>
			<span className="flex-1">{children ?? "Activity"}</span>
			<ChevronDownIcon
				aria-hidden="true"
				className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
			/>
		</CollapsibleTrigger>
	);
}

export function ChainOfThoughtContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
	return <CollapsibleContent className={cn("flex flex-col gap-0", className)} {...props} />;
}

export function ChainOfThoughtStep({
	icon: Icon = DotIcon,
	label,
	description,
	status = "complete",
	children,
	className,
	...props
}: Omit<ComponentProps<"div">, "title"> & {
	icon?: LucideIcon;
	label: ReactNode;
	description?: ReactNode;
	status?: "complete" | "active" | "pending";
}) {
	return (
		<div
			data-status={status}
			className={cn(
				"group/step flex items-start gap-3 text-ui leading-[1.125rem]",
				status === "pending" ? "text-ink-3" : "text-ink",
				className,
			)}
			{...props}
		>
			<div className="relative flex w-5 shrink-0 flex-col items-center self-stretch">
				{/* the icon's box is the label's first line box, so they centre together even when the label wraps */}
				<span aria-hidden="true" className="flex h-[1.125rem] shrink-0 items-center">
					<Icon className={cn("size-4 shrink-0", status === "active" ? "text-alive" : "text-ink-2")} />
				</span>
				<div className="my-2 w-px flex-1 bg-line-soft group-last/step:hidden" />
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-6">
				{label}
				{description ? <div className="text-meta text-ink-2">{description}</div> : null}
				{children}
			</div>
		</div>
	);
}

export function ChainOfThoughtSearchResults({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("flex flex-wrap items-center gap-2", className)} {...props} />;
}

export function ChainOfThoughtSearchResult(props: ComponentProps<typeof Badge>) {
	return <Badge variant="secondary" {...props} />;
}
