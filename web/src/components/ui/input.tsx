import type * as React from "react";
import { cn } from "@/lib/cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"w-full min-w-0 rounded-field border border-line bg-paper px-3 text-body text-ink outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)] placeholder:text-ink-2 focus-visible:border-ink-2 focus-visible:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ink)_8%,transparent)] disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-danger",
				"h-9 py-1",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
