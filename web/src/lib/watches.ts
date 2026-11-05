/**
 * An agent's watches as the panel reads them, pure: the rows (`watchRows`) from the watches as the daemon reports
 * them, their words for what each follows, what ends it and what it last saw, read at the time the daemon last
 * pushed, so nothing ticks on its own.
 */
import type { WatchView } from "../../../src/server/api.ts";
import { nearTime } from "../app/titles.ts";

/** A watch as a row of the panel's Watching list shows it. */
export type WatchRowView = {
	readonly id: string;
	/** What it follows, as the daemon names it: "acme/banda #142". */
	readonly name: string;
	/** The service it is on: "GitHub". */
	readonly service?: string | undefined;
	/** The object, by the reference its card is read by, once the daemon resolved it: the row draws it inline. */
	readonly object?: { readonly ref: string } | undefined;
	/** What ends it, in words: "until merged". */
	readonly until?: string | undefined;
	/** When it looks next, in words: "today 09:40". */
	readonly next?: string | undefined;
	/** What it last saw, or why it cannot look, in words. */
	readonly saw?: string | undefined;
	readonly paused?: boolean | undefined;
	readonly done?: boolean | undefined;
	readonly failing?: boolean | undefined;
	/** A change the agent asked for, waiting for the owner: what allowing it does. */
	readonly waiting?: "set up" | "change" | "stop" | undefined;
	readonly onAllow?: (() => void) | undefined;
	readonly onDecline?: (() => void) | undefined;
};

/** A time near `now`, lowercase where a sentence goes on: "today 09:00", "Fri 09:00". */
export const near = (at: number, now: number) =>
	nearTime(at, now).replace(/^(Today|Tomorrow|Yesterday)/, (word) => word.toLowerCase());

/** How a watch reads in its row: what it follows, by the daemon's name for it or the file's link. */
export function watchTitle(watch: WatchView): string {
	return (
		watch.object?.name ??
		watch.accepted?.watch?.object ??
		(watch.change !== undefined && "watch" in watch.change ? watch.change.watch?.object : undefined) ??
		watch.name
	);
}

/** What ends it, in words: "until merged"; undefined when the file leaves it to any of the kind's ends. */
export function untilWords(watch: WatchView): string | undefined {
	const until =
		watch.accepted?.watch?.until ??
		(watch.change !== undefined && "watch" in watch.change ? watch.change.watch?.until : undefined);
	return until === undefined ? undefined : `until ${until}`;
}

/** What the watch last saw, in words: "Saw today 09:10: ana approved"; "Looked today 09:10, nothing new". */
export function sawWords(watch: WatchView, now: number): string | undefined {
	if (watch.failed !== undefined) return `Can't look: ${watch.failed.why}`;
	if (watch.done !== undefined) return `Done ${near(watch.done.at, now)}: ${watch.done.why}`;
	if (watch.saw !== undefined && watch.sawAt !== undefined)
		return `Saw ${near(watch.sawAt, now)}: ${watch.saw.join(", ")}`;
	if (watch.looked !== undefined) return `Looked ${near(watch.looked, now)}, nothing new`;
	return undefined;
}

/**
 * Agent `agent`'s watches as its panel's rows, by name: each with what it follows, what ends it, what it last saw read
 * at `now`, and a change the agent made waiting for the owner, as it would be; `act` wires the owner's answers.
 */
export function watchRows(
	all: readonly WatchView[],
	agent: string,
	now: number,
	act?: { readonly allow: (name: string, sha: string | null) => void; readonly decline: (name: string) => void },
): WatchRowView[] {
	return all
		.filter((watch) => watch.agent === agent)
		.flatMap((watch): WatchRowView[] => {
			const change = watch.change;
			const file =
				(change !== undefined && change.kind !== "removed" ? change.watch : undefined) ?? watch.accepted?.watch;
			if (file === undefined) return [];
			const waiting =
				change === undefined
					? undefined
					: change.kind === "removed"
						? ("stop" as const)
						: watch.accepted === undefined
							? ("set up" as const)
							: ("change" as const);
			const saw = sawWords(watch, now);
			const until = untilWords(watch);
			return [
				{
					id: watch.name,
					name: watchTitle(watch),
					service: watch.object?.service,
					...(watch.object === undefined ? {} : { object: { ref: watch.object.ref } }),
					...(until === undefined ? {} : { until }),
					...(watch.next === undefined || waiting !== undefined ? {} : { next: near(watch.next, now) }),
					...(saw === undefined ? {} : { saw }),
					paused: watch.paused !== undefined,
					done: watch.done !== undefined,
					failing: watch.failed !== undefined,
					...(change === undefined
						? {}
						: {
								waiting,
								...(act === undefined
									? {}
									: {
											onAllow: () => act.allow(watch.name, change.kind === "removed" ? null : (change.sha ?? null)),
											onDecline: () => act.decline(watch.name),
										}),
							}),
				},
			];
		});
}
