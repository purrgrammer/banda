import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/cn";

/** Tabs: a row of words over a hairline; the one open is ink and underlined. */
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
	return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			className={cn("flex shrink-0 gap-4 border-b border-line-soft px-4", className)}
			{...props}
		/>
	);
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
	return (
		<TabsPrimitive.Trigger
			data-slot="tabs-trigger"
			className={cn(
				"relative -mb-px flex h-10 items-center border-b-2 border-transparent text-ui text-ink-2 outline-none",
				"transition-colors duration-[var(--duration-fast)] hover:text-ink",
				"focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus",
				"data-[state=active]:border-ink data-[state=active]:font-medium data-[state=active]:text-ink",
				className,
			)}
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
	return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
