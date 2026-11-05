import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/cn";

/** A switch: ink when on, a hairline track when off. Label it by what it does. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer group/switch relative inline-flex h-5 w-8 shrink-0 items-center rounded-full p-0.5 outline-none",
				"transition-colors duration-[var(--duration-fast)] after:absolute after:-inset-x-2 after:-inset-y-2",
				"focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus",
				"data-[state=checked]:bg-ink data-[state=unchecked]:bg-line",
				"disabled:cursor-not-allowed disabled:opacity-40",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block size-4 rounded-full bg-paper shadow-[0_1px_2px_oklch(0_0_0/20%)] transition-transform duration-[var(--duration-fast)] data-[state=checked]:translate-x-3"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
