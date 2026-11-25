import { useEffect, useState } from "react";

/**
 * The time a screen says ages and countdowns by, read again every `every` ms; it stands still while `every` is
 * undefined, and is `fixed` always when given (a specimen's). While it ticks a render reads the clock itself, so a
 * value that just arrived is never drawn against the time of the tick before it.
 */
export function useNow(every: number | undefined, fixed?: number): number {
	const [now, setNow] = useState(() => fixed ?? Date.now());
	useEffect(() => {
		if (every === undefined || fixed !== undefined) return;
		setNow(Date.now());
		const tick = setInterval(() => setNow(Date.now()), every);
		return () => clearInterval(tick);
	}, [every, fixed]);
	return fixed ?? (every === undefined ? now : Date.now());
}
