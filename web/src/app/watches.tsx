/**
 * An agent's watches in its panel, on the daemon's data: the rows (`watchRows`, from `../lib/watches.ts`, wired to
 * the owner's answers) and the detail the owner opens on one (`WatchDetail`): the object's card, what matters, and
 * the actions, each in effect at once; Edit changes what ends it and what matters.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WatchView } from "../../../src/server/api.ts";
import { clickKey } from "../areas/routines.ts";
import { actOnWatch, follow } from "../areas/watches.ts";
import { Facts } from "../chat/Approval.tsx";
import { Confirm } from "../chat/Confirm.tsx";
import { PanelBar, type WatchRowView } from "../chat/Panel.tsx";
import { Field } from "../chat/RoutineEditor.tsx";
import { showWatching } from "../lib/shell.ts";
import { near, watchRows as rows, sawWords, untilWords, watchTitle } from "../lib/watches.ts";
import { ObjectPreviews } from "./Objects.tsx";
import { hrefOf } from "./where.ts";

/** The owner's actions on a watch, wired to the daemon: each in effect at once, the panel drawn from its answer. */
export const watchActions = {
	allow: (name: string, sha: string | null) => actOnWatch(name, { action: "accept", sha }).then(showWatching),
	decline: (name: string) => actOnWatch(name, { action: "decline" }).then(showWatching),
	check: (name: string) => actOnWatch(name, { action: "check", key: clickKey() }).then(showWatching),
	pause: (name: string, paused: boolean) =>
		actOnWatch(name, { action: paused ? "pause" : "resume" }).then(showWatching),
	remove: (name: string) => actOnWatch(name, { action: "remove" }).then(showWatching),
	edit: (name: string, sha: string, change: { readonly until?: string | null; readonly ask?: string }) =>
		actOnWatch(name, { action: "edit", sha, ...change }).then(showWatching),
	follow: (made: Parameters<typeof follow>[0]) =>
		follow(made).then(({ control, watches }) => showWatching({ control, watches })),
};

/** Agent `agent`'s watches as its panel's rows, each answer wired to the daemon. */
export const watchRows = (all: readonly WatchView[], agent: string, now: number): WatchRowView[] =>
	rows(all, agent, now, {
		allow: (name, sha) => void watchActions.allow(name, sha),
		decline: (name) => void watchActions.decline(name),
	});

/** A watch's words as its editor holds them: what ends it (null: any of its ends) and what matters. */
type WatchDraft = { readonly until: string | null; readonly ask: string };

/** The detail's editor: closed, being written, being saved, or refused in the daemon's words. */
export type WatchEdit =
	| { readonly step: "closed" }
	| ({ readonly step: "editing" | "saving" } & WatchDraft)
	| ({ readonly step: "refused"; readonly why: string } & WatchDraft);

/** The Select's value for any end: none of the kind's ends, which are lowercase words, can be it. */
const ANY = "*";

/**
 * One watch, opened from its row: the object's card as the daemon reads it, what the watch is for, how it stands, and
 * its actions. Edit turns what ends it and what matters into fields, saved over the version shown. `onDone` goes back.
 */
export function WatchDetail({
	agent,
	chat,
	watch,
	now,
	edit: opened = { step: "closed" },
	onDone,
}: {
	/** The agent's id and name, whose chat it wakes. */
	agent: { readonly id: string; readonly name: string };
	/** The agent's chat, whose authority reads the card. */
	chat: number | undefined;
	watch: WatchView;
	now: number;
	/** The editor as it opens; closed unless the specimen shows it open. */
	edit?: WatchEdit;
	onDone: () => void;
}) {
	const file = watch.accepted?.watch;
	const sha = watch.accepted?.sha;
	const title = watchTitle(watch);
	const paused = watch.paused !== undefined;
	const saw = sawWords(watch, now);
	const [edit, setEdit] = useState<WatchEdit>(opened);
	const ends = watch.object?.ends ?? (file?.until === undefined ? [] : [file.until]);
	const save = (draft: WatchDraft) => {
		if (file === undefined || sha === undefined) return;
		const until = file.until ?? null;
		setEdit({ step: "saving", ...draft });
		watchActions
			.edit(watch.name, sha, {
				...(draft.until === until ? {} : { until: draft.until }),
				...(draft.ask === file.ask ? {} : { ask: draft.ask }),
			})
			.then(
				() => setEdit({ step: "closed" }),
				(refused: unknown) =>
					setEdit({ step: "refused", ...draft, why: refused instanceof Error ? refused.message : String(refused) }),
			);
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelBar title={title} detail={watch.object?.service} onBack={onDone} />
			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5">
				{watch.object === undefined || chat === undefined ? null : (
					<ObjectPreviews chat={chat} asks={[{ ref: watch.object.ref }]} agent={agent} />
				)}
				<Facts
					rows={[
						["Follows", title],
						...(edit.step !== "closed"
							? []
							: ([
									[
										"Ends",
										untilWords(watch)?.replace(/^until /, "") ??
											(watch.object?.ends === undefined
												? "at any of its ends"
												: watch.object.ends.length === 0
													? "when you stop it"
													: `when it is ${watch.object.ends.join(" or ")}`),
									],
								] as const)),
						...(watch.object?.account === undefined ? [] : ([["As", watch.object.account]] as const)),
						...(saw === undefined ? [] : ([["Last", saw]] as const)),
						...(watch.next === undefined || paused || watch.done !== undefined
							? []
							: ([["Next look", near(watch.next, now)]] as const)),
						...(file === undefined || edit.step !== "closed" ? [] : ([["What matters", file.ask]] as const)),
					]}
				/>
				{watch.failed?.off === true && watch.object !== undefined ? (
					<Button
						variant="outline"
						size="sm"
						className="self-start"
						onClick={() => {
							location.hash = hrefOf({ name: "connections", connection: watch.object?.connection as string });
						}}
					>
						Details
					</Button>
				) : null}
				<p className="text-meta text-ink-2">
					{watch.done !== undefined
						? `It ended: ${watch.done.why}. What it saw stays in the chat.`
						: `banda reads it on its own and wakes ${agent.name} with what changed; ${agent.name} says something only when it matters.`}
				</p>
			</div>
			<div data-watch-controls className="max-h-[70%] shrink-0 overflow-y-auto border-t border-line-soft px-4 py-4">
				{edit.step === "closed" ? null : (
					<form
						className="flex flex-col gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (edit.ask.trim() !== "") save(edit);
						}}
					>
						{ends.length === 0 ? null : (
							<Field label="Ends">
								<Select
									value={edit.until ?? ANY}
									disabled={edit.step === "saving"}
									onValueChange={(until) => setEdit({ ...edit, step: "editing", until: until === ANY ? null : until })}
								>
									<SelectTrigger aria-label="Ends" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ends.map((end) => (
											<SelectItem key={end} value={end}>
												When {end}
											</SelectItem>
										))}
										<SelectItem value={ANY}>Any end</SelectItem>
									</SelectContent>
								</Select>
							</Field>
						)}
						<Field label="What matters" hint={`${agent.name} reads this at every wake.`}>
							<Textarea
								value={edit.ask}
								maxLength={8000}
								disabled={edit.step === "saving"}
								className="min-h-28"
								onChange={(event) => setEdit({ ...edit, step: "editing", ask: event.target.value })}
							/>
						</Field>
						{edit.step === "refused" ? (
							<p role="alert" className="text-meta text-danger">
								{edit.why}
							</p>
						) : null}
						<span className="flex flex-wrap items-center gap-2">
							<Button type="submit" size="sm" disabled={edit.step === "saving" || edit.ask.trim() === ""}>
								{edit.step === "saving" ? "Saving…" : "Save"}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={edit.step === "saving"}
								onClick={() => setEdit({ step: "closed" })}
							>
								Cancel
							</Button>
						</span>
					</form>
				)}
				{edit.step !== "closed" ? null : (
					<span className="grid grid-cols-2 gap-2">
						{file === undefined ||
						sha === undefined ||
						watch.done !== undefined ||
						watch.change !== undefined ? null : (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setEdit({ step: "editing", until: file.until ?? null, ask: file.ask })}
							>
								Edit
							</Button>
						)}
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
				)}
			</div>
		</div>
	);
}
