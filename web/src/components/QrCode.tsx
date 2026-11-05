/**
 * A QR code of `value`, drawn as one SVG path. Always dark modules on a light tile, in either theme: a phone's camera
 * reads that reliably, and many scanners do not read the inverse.
 */
import { useMemo } from "react";
import { encode } from "uqr";
import { cn } from "@/lib/cn";

export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
	const { size, path } = useMemo(() => {
		const { data, size } = encode(value, { ecc: "M", border: 2 });
		let path = "";
		data.forEach((row, y) => {
			row.forEach((dark, x) => {
				if (dark) path += `M${x} ${y}h1v1h-1z`;
			});
		});
		return { size, path };
	}, [value]);
	return (
		<svg
			role="img"
			aria-label={label}
			viewBox={`0 0 ${size} ${size}`}
			shapeRendering="crispEdges"
			className={cn("aspect-square rounded-field bg-white", className)}
		>
			<path d={path} fill="#000" />
		</svg>
	);
}
