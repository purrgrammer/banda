/**
 * A recorded conversation read from a fork, local only, through the app's own activity sheet. No prompts, results or
 * personal data live in this file.
 */
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Item, ToolCall } from "../../../../src/server/api.ts";
import { ActivitySheet } from "../../app/Activity.tsx";
import { Face } from "../../chat/Face.tsx";
import { Bubble, Run } from "../../chat/Feed.tsx";
import { SANCHO } from "../fixtures.ts";
import { transcriptOf } from "./activity.tsx";
import type { RecordedActivity, RecordedRun } from "./recorded-types.ts";

type Called = { call: ToolCall; result?: Extract<Item, { role: "tool" }>; at?: number };

function callsOf(run: RecordedRun): Called[] {
	return run.items.flatMap((item) =>
		item.role === "assistant"
			? (item.calls ?? []).map((call) => {
					const result = run.items.find(
						(i): i is Extract<Item, { role: "tool" }> => i.role === "tool" && i.call === call.id,
					);
					return { call, ...(result ? { result } : {}), ...(item.at === undefined ? {} : { at: item.at }) };
				})
			: [],
	);
}
function clock(at: number | undefined) {
	return at === undefined ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function RecordedActivityPreview() {
	const [data, setData] = useState<RecordedActivity>();
	const [error, setError] = useState<string>();
	const [scheme, setScheme] = useState("light");
	const [width, setWidth] = useState("desktop");
	useEffect(() => {
		const controller = new AbortController();
		void fetch("/__specimen/activity", { signal: controller.signal, cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error("No private conversation loaded in this preview.");
				setData((await response.json()) as RecordedActivity);
			})
			.catch((err) => {
				if (!controller.signal.aborted) setError(String(err.message ?? err));
			});
		return () => controller.abort();
	}, []);
	return (
		<div style={{ colorScheme: scheme }} className="flex h-svh flex-col bg-paper-2 text-ink">
			<header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft bg-paper px-4 py-3">
				<span className="text-meta text-ink-2">Activity · recorded conversation</span>
				<div className="ml-auto flex flex-wrap gap-2">
					<Tabs value={scheme} onValueChange={setScheme}>
						<TabsList aria-label="Theme">
							<TabsTrigger value="light">Light</TabsTrigger>
							<TabsTrigger value="dark">Dark</TabsTrigger>
						</TabsList>
					</Tabs>
					<Tabs value={width} onValueChange={setWidth}>
						<TabsList aria-label="Preview width">
							<TabsTrigger value="desktop">Desktop</TabsTrigger>
							<TabsTrigger value="phone">Phone</TabsTrigger>
						</TabsList>
					</Tabs>
					<Button variant="ghost" size="sm" asChild>
						<a href="#/specimen/activity">Fixture</a>
					</Button>
				</div>
			</header>
			<div className="border-b border-line-soft px-4 py-2 text-meta text-ink-2">
				Read-only snapshot from a fork · actual model context and tool results · no new model requests
			</div>
			<div
				className={
					width === "phone"
						? "mx-auto flex min-h-0 w-full max-w-[390px] flex-1 border-x border-line-soft"
						: "mx-auto flex min-h-0 w-full max-w-[960px] flex-1 border-x border-line-soft"
				}
			>
				{data ? (
					<RecordedChat data={data} scheme={scheme} />
				) : (
					<p className="p-5 text-ui text-ink-2">{error ?? "Loading recorded conversation…"}</p>
				)}
			</div>
		</div>
	);
}

function RecordedChat({ data, scheme }: { data: RecordedActivity; scheme: string }) {
	const who = { name: data.agent.name, face: data.agent.face ?? SANCHO.face };
	const [selected, setSelected] = useState<RecordedRun>();
	const research = data.runs.find((run) => callsOf(run).length > 10) ?? data.runs[0];
	return (
		<div className="flex min-w-0 flex-1 flex-col bg-paper" data-recorded-chat="">
			<header className="flex h-16 shrink-0 items-center gap-3 border-b border-line-soft px-4">
				<Face face={who.face} name={who.name} size="message" />
				<div className="flex min-w-0 flex-col items-start">
					<span className="text-heading font-semibold">{data.agent.name}</span>
					<button
						type="button"
						onClick={() => research && setSelected(research)}
						className="flex items-center gap-1 rounded-field text-meta text-ink-2 hover:text-ink"
						aria-label="View recorded activity"
					>
						Research completed
						<ChevronRightIcon aria-hidden="true" className="size-3" />
					</button>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-[44rem] flex-col gap-6 px-4 py-6">
					{data.runs.map((run) => (
						<div key={run.id} className="flex flex-col gap-5">
							{run.kind === "user" ? (
								<Run time={clock(run.at)}>
									<Bubble copy={run.input}>{run.input}</Bubble>
								</Run>
							) : (
								<p className="text-meta text-ink-2">Routine · {run.input}</p>
							)}
							{callsOf(run)
								.filter(
									({ call, result }) =>
										call.name === "message_user" && result && !result.error && typeof call.args.text === "string",
								)
								.map(({ call, at }) => (
									<Run key={call.id} who={who} time={clock(at)}>
										<Bubble copy={String(call.args.text)} onActivity={() => setSelected(run)}>
											<Markdown>{String(call.args.text)}</Markdown>
										</Bubble>
									</Run>
								))}
						</div>
					))}
				</div>
			</div>
			{selected === undefined ? null : (
				<ActivitySheet
					targets={[{ chat: selected.id, name: data.agent.name, heading: selected.input }]}
					source={{ chat: selected.id, transcript: transcriptOf(selected.items), prompt: selected.prompt }}
					onClose={() => setSelected(undefined)}
					style={{ colorScheme: scheme }}
				/>
			)}
		</div>
	);
}
