/** A routine's name as a title: pure, for the tests. */

/**
 * A routine's file name (lowercase words joined by `-`) as words, each word as its description writes it, so a name
 * keeps its capital (call-ana and "remind you to call Ana" read Call Ana); the first word capitalised.
 */
export function routineTitle(name: string, description?: string): string {
	// a word's casing where a sentence does not start with it; all lowercase anywhere wins
	const said = new Map<string, string>();
	for (const match of description?.matchAll(/[\p{L}\p{N}]+/gu) ?? []) {
		const word = match[0];
		const key = word.toLowerCase();
		const opening = /(^|[.!?:])\s*$/.test((description ?? "").slice(0, match.index));
		const known = said.get(key);
		if (word === key) said.set(key, word);
		else if (!opening && known !== key) said.set(key, word);
	}
	const words = name.split("-").map((word) => said.get(word) ?? word);
	const [first = "", ...rest] = words;
	return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** A time near `now` in words: "Today 09:00", "Tomorrow 09:00", "Fri 09:00" within the week, else "12 Nov 09:00". */
export function nearTime(at: number, now: number): string {
	const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const midnight = (when: number) => new Date(when).setHours(0, 0, 0, 0);
	const days = Math.round((midnight(at) - midnight(now)) / 86_400_000);
	if (days === 0) return `Today ${time}`;
	if (days === 1) return `Tomorrow ${time}`;
	if (days === -1) return `Yesterday ${time}`;
	if (days > 1 && days < 7) return `${new Date(at).toLocaleDateString([], { weekday: "short" })} ${time}`;
	return `${new Date(at).toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
