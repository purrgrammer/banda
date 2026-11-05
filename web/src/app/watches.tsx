/**
 * An agent's watches in its panel, on the daemon's data: the rows (`watchRows`, from `../lib/watches.ts`, wired to
 * the owner's answers) and the detail the owner opens on one (`WatchDetail`): the object's card, what matters, and
 * the actions, each in effect at once.
 */

import { Button } from "@/components/ui/button";
import type { WatchView } from "../../../src/server/api.ts";
import { clickKey } from "../areas/routines.ts";
import { actOnWatch, follow } from "../areas/watches.ts";
import { Facts } from "../chat/Approval.tsx";
import { Confirm } from "../chat/Confirm.tsx";
import { PanelBar, type WatchRowView } from "../chat/Panel.tsx";
import { showControl } from "../lib/shell.ts";
import { near, watchRows as rows, sawWords, untilWords, watchTitle } from "../lib/watches.ts";
import { ObjectPreviews } from "./Objects.tsx";

/** The owner's actions on a watch, wired to the daemon: each in effect at once. */
export const watchActions = {
	allow: (name: string, sha: string | null) => actOnWatch(name, { action: "accept", sha }).then(showControl),
	decline: (name: string) => actOnWatch(name, { action: "decline" }).then(showControl),
	check: (name: string) => actOnWatch(name, { action: "check", key: clickKey() }).then(showControl),
	pause: (name: string, paused: boolean) => actOnWatch(name, { action: paused ? "pause" : "resume" }).then(showControl),
	remove: (name: string) => actOnWatch(name, { action: "remove" }).then(showControl),
	follow: (made: Parameters<typeof follow>[0]) => follow(made).then(({ control }) => showControl(control)),
};

/** Agent `agent`'s watches as its panel's rows, each answer wired to the daemon. */
export const watchRows = (all: readonly WatchView[], agent: string, now: number): WatchRowView[] =>
	rows(all, agent, now, {
		allow: (name, sha) => void watchActions.allow(name, sha),
		decline: (name) => void watchActions.decline(name),
	});

/**
 * One watch, opened from its row: the object's card as the daemon reads it, what the watch is for, how it stands, and
 * its actions. `onDone` goes back.
 */
export function WatchDetail({
	agent,
	chat,
	watch,
	now,
	onDone,
}: {
	/** The agent's id and name, whose chat it wakes. */
	agent: { readonly id: string; readonly name: string };
	/** The agent's chat, whose authority reads the card. */
	chat: number | undefined;
	watch: WatchView;
	now: number;
	onDone: () => void;
}) {
	const file = watch.accepted?.watch;
	const title = watchTitle(watch);
	const paused = watch.paused !== undefined;
	const saw = sawWords(watch, now);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelBar title={title} detail={watch.object?.service} onBack={onDone} />
			<div className="flex flex-col gap-5 overflow-y-auto px-4 py-5">
				{watch.object === undefined || chat === undefined ? null : (
					<ObjectPreviews chat={chat} asks={[{ ref: watch.object.ref }]} agent={agent} />
				)}
				<Facts
					rows={[
						["Follows", title],
						["Ends", untilWords(watch)?.replace(/^until /, "") ?? "when it is merged or closed"],
						...(watch.object?.account === undefined ? [] : ([["As", watch.object.account]] as const)),
						...(saw === undefined ? [] : ([["Last", saw]] as const)),
						...(watch.next === undefined || paused || watch.done !== undefined
							? []
							: ([["Next look", near(watch.next, now)]] as const)),
						...(file === undefined ? [] : ([["What matters", file.ask]] as const)),
					]}
				/>
				<p className="text-meta text-ink-2">
					{watch.done !== undefined
						? `It ended: ${watch.done.why}. What it saw stays in the chat.`
						: `banda reads it on its own and wakes ${agent.name} with what changed; ${agent.name} says something only when it matters.`}
				</p>
				<span className="flex flex-wrap items-center gap-2">
					{watch.done !== undefined ? null : (
						<Button variant="outline" size="sm" onClick={() => void watchActions.check(watch.name)}>
							Check now
						</Button>
					)}
					{watch.done !== undefined ? null : (
						<Button variant="outline" size="sm" onClick={() => void watchActions.pause(watch.name, !paused)}>
							{paused ? "Resume" : "Pause"}
						</Button>
					)}
					{watch.done === undefined ? (
						// stopping is asked first, as every destructive action is
						<Confirm
							title={`Stop following ${title}?`}
							body={`${agent.name} stops looking at it, and no longer wakes for what changes there. What it saw stays in the chat.`}
							action="Stop"
							keep="Keep following"
							onConfirm={() =>
								void watchActions.remove(watch.name).then(() => {
									onDone();
								})
							}
						>
							<Button variant="destructive" size="sm">
								Stop
							</Button>
						</Confirm>
					) : (
						<Button
							variant="ghost"
							size="sm"
							onClick={() =>
								void watchActions.remove(watch.name).then(() => {
									onDone();
								})
							}
						>
							Remove
						</Button>
					)}
				</span>
			</div>
		</div>
	);
}
