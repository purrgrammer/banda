/**
 * When a routine is due (DESIGN.md "Routines"): every so long, once at a time, or on a cron-like schedule, in the
 * daemon's local time. Plain data and pure functions, so the app says a routine's schedule in the same words the daemon
 * keeps it by.
 */

const MINUTE = 60_000;
const UNITS: { readonly [unit: string]: number } = {
	m: MINUTE,
	h: 60 * MINUTE,
	d: 24 * 60 * MINUTE,
	w: 7 * 24 * 60 * MINUTE,
};

/** A routine's schedule: every `every` ms from when it was allowed, once `at` (epoch ms), or on `cron`'s minutes. */
export type When = { readonly every: number } | { readonly at: number } | { readonly cron: string };

/** `30m`, `2h`, `1d`, `1w` as ms; undefined when it is not one, or under a minute. */
export function parseEvery(text: string): number | undefined {
	const match = /^(\d{1,4})\s*([mhdw])$/.exec(text.trim());
	if (match === null) return undefined;
	const ms = Number(match[1]) * (UNITS[match[2] ?? ""] ?? 0);
	return ms >= MINUTE ? ms : undefined;
}

/** `2026-11-02 09:00` (or with a `T`), local time, as epoch ms; undefined when it is not one. */
export function parseAt(text: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
	if (match === null) return undefined;
	const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
	const date = new Date(y, mo - 1, d, h, mi);
	// a date that rolled over (the 31st of a 30-day month, hour 25) is not the one written
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h)
		return undefined;
	return date.getTime();
}

/** A cron field's allowed values, in order. */
type Field = readonly number[];
type Cron = {
	readonly minutes: Field;
	readonly hours: Field;
	readonly days: Field;
	readonly months: Field;
	readonly weekdays: Field;
	/** Whether day of month and day of week were each restricted: when both are, either may match. */
	readonly dayRestricted: boolean;
	readonly weekdayRestricted: boolean;
};

const RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
] as const;

/** One cron field (`*`, `5`, `1-5`, `*\/15`, `1,15`, `0-30/10`) as its values; undefined when malformed. */
function field(text: string, min: number, max: number): Field | undefined {
	const values = new Set<number>();
	for (const part of text.split(",")) {
		const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (match === null) return undefined;
		const step = match[4] === undefined ? 1 : Number(match[4]);
		const from = match[1] === "*" ? min : Number(match[2]);
		const to =
			match[1] === "*" ? max : match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
		if (step < 1 || from < min || to > max || from > to) return undefined;
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return [...values].sort((a, b) => a - b);
}

/** Five fields: minute, hour, day of month, month, day of week (0 or 7 is Sunday); undefined when malformed. */
export function parseCron(text: string): Cron | undefined {
	const parts = text.trim().split(/\s+/);
	if (parts.length !== 5) return undefined;
	const fields = parts.map((part, i) => field(part, RANGES[i]?.[0] ?? 0, RANGES[i]?.[1] ?? 0));
	if (fields.some((f) => f === undefined)) return undefined;
	const [minutes, hours, days, months, weekdays] = fields as [Field, Field, Field, Field, Field];
	return {
		minutes,
		hours,
		days,
		months,
		weekdays: [...new Set(weekdays.map((day) => day % 7))].sort((a, b) => a - b),
		dayRestricted: parts[2] !== "*",
		weekdayRestricted: parts[4] !== "*",
	};
}

/** How far ahead a cron schedule is searched: one that matches no day in five years never comes. */
const CRON_DAYS = 5 * 366;

function cronAfter(cron: Cron, after: number): number | undefined {
	const start = new Date(after);
	start.setSeconds(0, 0);
	const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
	for (let i = 0; i < CRON_DAYS; i++, day.setDate(day.getDate() + 1)) {
		if (!cron.months.includes(day.getMonth() + 1)) continue;
		const byDay = cron.days.includes(day.getDate());
		const byWeekday = cron.weekdays.includes(day.getDay());
		const matches =
			cron.dayRestricted && cron.weekdayRestricted
				? byDay || byWeekday
				: cron.dayRestricted
					? byDay
					: cron.weekdayRestricted
						? byWeekday
						: true;
		if (!matches) continue;
		for (const hour of cron.hours)
			for (const minute of cron.minutes) {
				const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
				if (at > after) return at;
			}
	}
	return undefined;
}

/**
 * The first time `when` is due strictly after `after`: `every` counts from `since` (when the routine was allowed), `at`
 * comes once, `cron` on its minutes. Undefined: it is never due again.
 */
export function nextDue(when: When, after: number, since: number): number | undefined {
	if ("at" in when) return when.at > after ? when.at : undefined;
	if ("every" in when) {
		if (after < since) return since + when.every;
		return since + (Math.floor((after - since) / when.every) + 1) * when.every;
	}
	const cron = parseCron(when.cron);
	return cron === undefined ? undefined : cronAfter(cron, after);
}

/** A time as a routine file writes one, local: `2026-11-02 09:00`. */
export function localTime(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

function everyWords(ms: number): string {
	for (const [unit, one, many] of [
		["w", "week", "weeks"],
		["d", "day", "days"],
		["h", "hour", "hours"],
		["m", "minute", "minutes"],
	] as const) {
		const size = UNITS[unit] ?? 1;
		if (ms % size !== 0) continue;
		const n = ms / size;
		return n === 1 ? `Every ${one}` : `Every ${n} ${many}`;
	}
	return `Every ${Math.round(ms / MINUTE)} minutes`;
}

/**
 * The schedule in plain words, as the owner reads it ("Every day at 09:00", "Weekdays at 08:30"); a schedule with no
 * plain words is "On its own schedule". A one-time routine says only that it runs once: the app writes the time itself.
 */
export function whenWords(when: When): string {
	if ("every" in when) return everyWords(when.every);
	if ("at" in when) return "Once";
	const parts = when.cron.trim().split(/\s+/);
	const [minute = "", hour = "", day = "", month = "", weekday = ""] = parts;
	const fixed = (text: string) => /^\d+$/.test(text);
	const step = /^\*\/(\d+)$/.exec(minute);
	if (step !== null && [hour, day, month, weekday].every((p) => p === "*")) return everyWords(Number(step[1]) * MINUTE);
	if (fixed(minute) && hour === "*" && [day, month, weekday].every((p) => p === "*"))
		return `Every hour at :${pad(Number(minute))}`;
	if (!fixed(minute) || !fixed(hour) || month !== "*") return "On its own schedule";
	const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
	if (day === "*" && weekday === "*") return `Every day at ${time}`;
	if (day === "*" && weekday === "1-5") return `Weekdays at ${time}`;
	if (day === "*" && (weekday === "0,6" || weekday === "6,0")) return `Weekends at ${time}`;
	if (day === "*" && fixed(weekday)) return `Every ${WEEKDAYS[Number(weekday) % 7]} at ${time}`;
	if (day === "*" && /^\d(,\d)+$/.test(weekday)) {
		const days = [...new Set(weekday.split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b);
		const names = days.map((d) => `${WEEKDAYS[d]}s`);
		return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} at ${time}`;
	}
	if (fixed(day) && weekday === "*") return `Monthly on day ${Number(day)} at ${time}`;
	return "On its own schedule";
}

/** `ms` as a routine file writes a period: the largest unit it is a whole number of (`4h`, `90m`, `1w`). */
export function everyText(ms: number): string {
	for (const unit of ["w", "d", "h", "m"] as const) {
		const size = UNITS[unit] ?? MINUTE;
		if (ms % size === 0) return `${ms / size}${unit}`;
	}
	return `${Math.max(1, Math.round(ms / MINUTE))}m`;
}

/**
 * A schedule as one line, as the owner's edit sends it: `every 4h`, `at 2026-11-02 09:00` or `cron 0 8 * * 1-5`; the
 * first word is the routine file's field, the rest its value.
 */
export function scheduleText(when: When): string {
	if ("every" in when) return `every ${everyText(when.every)}`;
	if ("at" in when) return `at ${localTime(when.at)}`;
	return `cron ${when.cron.trim().split(/\s+/).join(" ")}`;
}

/** The field and value a schedule line names (`every`, `4h`); undefined when it is not one a routine file takes. */
export function scheduleField(
	text: string,
): { readonly key: "every" | "at" | "cron"; readonly value: string } | undefined {
	const match = /^\s*(every|at|cron)\s+(\S.*?)\s*$/.exec(text);
	if (match === null) return undefined;
	const key = match[1] as "every" | "at" | "cron";
	const value = key === "cron" ? (match[2] ?? "").split(/\s+/).join(" ") : (match[2] ?? "");
	return { key, value };
}

/** A schedule line (`scheduleText`) as a schedule; undefined when it is not one. */
export function parseSchedule(text: string): When | undefined {
	const field = scheduleField(text);
	if (field === undefined) return undefined;
	if (field.key === "every") {
		const every = parseEvery(field.value);
		return every === undefined ? undefined : { every };
	}
	if (field.key === "at") {
		const at = parseAt(field.value);
		return at === undefined ? undefined : { at };
	}
	return parseCron(field.value) === undefined ? undefined : { cron: field.value };
}

/**
 * The next `count` times `when` is due after `after`, in order, each strictly after the one before; fewer when it
 * stops (a one-time routine) or the next comes after `until`.
 */
export function nextRuns(
	when: When,
	after: number,
	since: number,
	count = 3,
	until = Number.POSITIVE_INFINITY,
): number[] {
	const runs: number[] = [];
	for (let at = after; runs.length < count; ) {
		const due = nextDue(when, at, since);
		if (due === undefined || due > until) break;
		runs.push(due);
		at = due;
	}
	return runs;
}

/**
 * What the schedule picker offers the owner: every day, weekdays, some days of the week, each at a time; every few
 * hours; once; or a cron line behind "custom". Times are `HH:MM`, local; days 0 (Sunday) to 6.
 */
export type SchedulePick =
	| { readonly kind: "daily"; readonly time: string }
	| { readonly kind: "weekdays"; readonly time: string }
	| { readonly kind: "weekly"; readonly days: readonly number[]; readonly time: string }
	| { readonly kind: "hours"; readonly hours: number }
	| { readonly kind: "once"; readonly at: string }
	/** A cron line (minute hour day month weekday), or a period (`45m`, `2d`). */
	| { readonly kind: "custom"; readonly text: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A pick as a schedule line, or why it is not one, in words for the owner. */
export function pickSchedule(pick: SchedulePick): { readonly text: string } | { readonly error: string } {
	const at = (time: string, days: string) => {
		const match = TIME.exec(time);
		if (match === null) return { error: "Pick a time, such as 08:00." };
		return { text: `cron ${Number(match[2])} ${Number(match[1])} * * ${days}` };
	};
	switch (pick.kind) {
		case "daily":
			return at(pick.time, "*");
		case "weekdays":
			return at(pick.time, "1-5");
		case "weekly": {
			const days = [...new Set(pick.days)].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
			if (days.length === 0) return { error: "Pick at least one day." };
			const list = days.sort((a, b) => a - b).join(",");
			// every day, or Monday to Friday, said the short way
			return at(pick.time, list === "0,1,2,3,4,5,6" ? "*" : list === "1,2,3,4,5" ? "1-5" : list);
		}
		case "hours":
			if (!Number.isInteger(pick.hours) || pick.hours < 1 || pick.hours > 168)
				return { error: "Every 1 to 168 hours." };
			return { text: `every ${everyText(pick.hours * (UNITS.h ?? 0))}` };
		case "once": {
			const text = pick.at.trim().replace("T", " ");
			return parseAt(text) === undefined ? { error: "Pick a day and a time." } : { text: `at ${text}` };
		}
		case "custom": {
			const text = pick.text.trim().split(/\s+/).join(" ");
			if (parseEvery(text) !== undefined) return { text: `every ${text}` };
			return parseCron(text) === undefined
				? { error: "Write minute hour day month weekday, such as 0 8 * * 1-5, or a period, such as 45m." }
				: { text: `cron ${text}` };
		}
	}
}

/** The pick that shows a schedule in the picker: its preset when it is one, else custom. */
export function pickOf(when: When): SchedulePick {
	if ("at" in when) return { kind: "once", at: localTime(when.at) };
	if ("every" in when) {
		const hours = when.every / (UNITS.h ?? 1);
		if (Number.isInteger(hours) && hours >= 1 && hours <= 168) return { kind: "hours", hours };
		return { kind: "custom", text: everyText(when.every) };
	}
	const cron = when.cron.trim().split(/\s+/).join(" ");
	const [minute = "", hour = "", day = "", month = "", weekday = ""] = cron.split(" ");
	const fixed = (text: string) => /^\d+$/.test(text);
	if (fixed(minute) && fixed(hour) && day === "*" && month === "*") {
		const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
		if (weekday === "*") return { kind: "daily", time };
		if (weekday === "1-5") return { kind: "weekdays", time };
		if (/^\d(,\d)*$/.test(weekday))
			return {
				kind: "weekly",
				days: [...new Set(weekday.split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b),
				time,
			};
	}
	return { kind: "custom", text: cron };
}
