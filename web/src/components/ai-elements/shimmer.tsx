/**
 * ai-elements' Shimmer: text a light sweeps across while something runs. A CSS animation here, where ai-elements
 * drives the same gradient with motion: one less dependency, and it stops for reduced motion.
 */

import { type CSSProperties, type ElementType, memo } from "react";
import { cn } from "@/lib/cn";

export type TextShimmerProps = {
	children: string;
	as?: ElementType;
	className?: string;
	/** Seconds per sweep. */
	duration?: number;
	/** How wide the light is, per character. */
	spread?: number;
};

const ShimmerComponent = ({ children, as: Component = "p", className, duration = 2, spread = 2 }: TextShimmerProps) => (
	<Component
		className={cn(
			"relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box] motion-safe:animate-[sa-shimmer_var(--duration)_linear_infinite] motion-reduce:text-muted-foreground",
			"[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]",
			className,
		)}
		style={
			{
				"--spread": `${children.length * spread}px`,
				"--duration": `${duration}s`,
				backgroundImage: "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
			} as CSSProperties
		}
	>
		{children}
	</Component>
);

export const Shimmer = memo(ShimmerComponent);
