import type * as React from "react";
import { cn } from "@/lib/cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"w-full min-w-0 rounded-field border border-line bg-paper px-3 text-body text-ink outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)] placeholder:text-ink-2 focus-visible:border-ink-2 focus-visible:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ink)_8%,transparent)] disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-danger",
				"field-sizing-content flex min-h-16 py-2",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
