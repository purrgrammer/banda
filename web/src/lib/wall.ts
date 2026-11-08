/**
 * An event's time as a picker edits it: the wall clock it was given in, never moved to the browser's zone. Google's
 * times are RFC 3339 with their offset ("2026-11-09T16:00:00+01:00"); an all-day event's is a date.
 */
const WHEN = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** What a picker shows: "2026-11-09T16:00" for a time, "2026-11-09" for a date; "" when it is neither. */
export function wallOf(value: string): string {
	const match = WHEN.exec(value);
	if (match === null) return "";
	return match[2] === undefined ? (match[1] as string) : `${match[1]}T${match[2]}`;
}

/** The browser's offset at that moment, as RFC 3339 writes it. */
function offsetAt(wall: string): string {
	const minutes = -new Date(wall).getTimezoneOffset();
	if (!Number.isFinite(minutes)) return "Z";
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The value a picker's `wall` makes of `previous`: a date stays a date; a time keeps the offset it was given in. */
export function withWall(previous: string, wall: string): string {
	if (wall === "" || /^\d{4}-\d{2}-\d{2}$/.test(wall)) return wall;
	return `${wall}:00${OFFSET.exec(previous)?.[1] ?? offsetAt(wall)}`;
}
