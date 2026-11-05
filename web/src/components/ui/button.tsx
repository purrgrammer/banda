import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
	"group/button relative inline-flex shrink-0 items-center justify-center rounded-field border border-transparent bg-clip-padding text-ui font-medium whitespace-nowrap transition-[background-color,color,box-shadow,opacity] duration-[var(--duration-fast)] outline-none select-none focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				/* the one primary action on a card: ink, filled */
				default: "bg-ink text-paper hover:bg-ink/85",
				/* a quiet action beside it, framed */
				outline: "border-line bg-paper text-ink hover:bg-paper-3 aria-expanded:bg-paper-3",
				secondary: "bg-paper-3 text-ink hover:bg-[color-mix(in_oklch,var(--paper-3),var(--ink)_6%)]",
				/* a quiet action, unframed: Don't, Cancel, an icon */
				ghost: "text-ink hover:bg-paper-3 aria-expanded:bg-paper-3",
				destructive: "text-danger hover:bg-[color-mix(in_oklch,var(--danger)_10%,transparent)]",
				link: "h-auto px-0 text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink",
			},
			size: {
				default: "h-9 gap-1.5 px-3.5",
				xs: "h-7 gap-1 px-2 text-meta pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:inset-x-0 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1 px-3 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:inset-x-0 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-10 gap-2 px-4 text-body",
				/* on a touch screen the small ones reach 44px with an invisible margin, not a bigger look */
				icon: "size-9 pointer-coarse:after:absolute pointer-coarse:after:-inset-1",
				"icon-xs":
					"size-7 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-8 pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
