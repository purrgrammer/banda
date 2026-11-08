/**
 * The day turning, for words that name one: "Today 09:40" is "Yesterday 09:40" after midnight, and the band's rows
 * say a weekday for a message older than today. The words are read at the daemon's pushes; a push the day's turning
 * owes comes from here, since no doc moves at midnight.
 */
import { useEffect, useState } from "react";

/** A number that grows at each local midnight: read it where words depend on which day it is. */
export function useMidnight(): number {
	const [day, setDay] = useState(0);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const arm = () => {
			const next = new Date();
			next.setHours(24, 0, 0, 0);
			timer = setTimeout(
				() => {
					setDay((n) => n + 1);
					arm();
				},
				next.getTime() - Date.now() + 1_000,
			);
		};
		arm();
		return () => clearTimeout(timer);
	}, []);
	return day;
}
