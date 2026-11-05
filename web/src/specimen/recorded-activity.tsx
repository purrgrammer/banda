/** A local-only recorded conversation, read from a fork. No prompts, results or personal data live in this file. */
import { ArrowLeftIcon, ChevronRightIcon, MessageSquareIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	ChainOfThought,
	ChainOfThoughtContent,
	ChainOfThoughtHeader,
	ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Terminal } from "@/components/ai-elements/terminal";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Item, ToolCall } from "../../../src/server/api.ts";
import { ModelContext, RawRow, RawValue } from "../chat/ActivityDetail.tsx";
import { Face } from "../chat/Face.tsx";
import { Bubble, Run } from "../chat/Feed.tsx";
import { ToolIcon, toolIcon, toolPreview } from "../chat/tool-presentation.tsx";
import { SANCHO } from "./fixtures.ts";
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
function activityTitle(call: ToolCall) {
	if (call.name === "web_fetch" || call.name === "browser_navigate") {
		try {
			return `Reading ${new URL(String(call.args.url)).hostname}`;
		} catch {
			return "Reading a page";
		}
	}
	if (call.name === "message_user") return "Sending a message";
	if (call.name === "remember") return "Remembering a preference";
	if (call.name === "schedule") return "Setting up the weekly roundup";
	return call.name;
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
	const [depth, setDepth] = useState<"activity" | "transcript">("activity");
	const heading = useRef<HTMLHeadingElement>(null);
	const open = (run: RecordedRun) => {
		setSelected(run);
		setDepth("activity");
	};
	const drill = (next: "activity" | "transcript") => {
		setDepth(next);
		requestAnimationFrame(() => heading.current?.focus());
	};
	const research = data.runs.find((run) => callsOf(run).length > 10) ?? data.runs[0];
	return (
		<div className="flex min-w-0 flex-1 flex-col bg-paper" data-recorded-chat="">
			<header className="flex h-16 shrink-0 items-center gap-3 border-b border-line-soft px-4">
				<Face face={who.face} name={who.name} size="message" />
				<div className="flex min-w-0 flex-col items-start">
					<span className="text-heading font-semibold">{data.agent.name}</span>
					<button
						type="button"
						onClick={() => research && open(research)}
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
										<Bubble copy={String(call.args.text)} onActivity={() => open(run)}>
											<Markdown>{String(call.args.text)}</Markdown>
										</Bubble>
									</Run>
								))}
						</div>
					))}
				</div>
			</div>
			<Sheet
				open={!!selected}
				onOpenChange={(value) => {
					if (!value) setSelected(undefined);
				}}
			>
				<SheetContent
					style={{ colorScheme: scheme }}
					className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						heading.current?.focus();
					}}
				>
					<SheetHeader className="gap-2 border-b border-line-soft pr-12">
						{depth === "transcript" ? (
							<Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => drill("activity")}>
								<ArrowLeftIcon data-icon="inline-start" />
								Activity
							</Button>
						) : null}
						<SheetTitle ref={heading} tabIndex={-1} className="outline-none">
							{depth === "activity" ? "Activity" : "Full transcript"}
						</SheetTitle>
						<SheetDescription>
							{data.agent.name} · recorded · {clock(selected?.at)}
						</SheetDescription>
					</SheetHeader>
					{selected ? (
						depth === "activity" ? (
							<div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
								<p className="mb-6 text-body font-medium">{selected.input}</p>
								<ChainOfThought defaultOpen>
									<ChainOfThoughtHeader>How the work was done</ChainOfThoughtHeader>
									<ChainOfThoughtContent>
										{callsOf(selected).map(({ call, result }) => (
											<ChainOfThoughtStep
												key={call.id}
												icon={toolIcon(call.name)}
												label={
													<button
														type="button"
														onClick={() => drill("transcript")}
														className="flex min-h-11 w-full flex-col gap-1.5 rounded-field px-1 py-2 text-left hover:bg-paper-2"
														aria-label={`Inspect recorded call ${call.id}`}
													>
														<span className="flex w-full items-center justify-between gap-2">
															<span>{activityTitle(call)}</span>
															<ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
														</span>
														{toolPreview(call.name, call.args) ? (
															<span
																data-tool-preview=""
																className="line-clamp-2 break-words text-meta text-ink-2 [overflow-wrap:anywhere]"
															>
																{toolPreview(call.name, call.args)}
															</span>
														) : null}
														<span className="text-meta text-ink-2">
															{result?.error ? "Failed" : "Done"}
															{result?.durationMs === undefined ? "" : ` · ${(result.durationMs / 1000).toFixed(1)}s`}
														</span>
													</button>
												}
											/>
										))}
									</ChainOfThoughtContent>
								</ChainOfThought>
							</div>
						) : (
							<RecordedTranscript run={selected} />
						)
					) : null}
				</SheetContent>
			</Sheet>
		</div>
	);
}

function RecordedTranscript({ run }: { run: RecordedRun }) {
	const called = new Map(callsOf(run).map((c) => [c.call.id, c]));
	return (
		<Conversation aria-label="Recorded activity" aria-live="off">
			<ConversationContent className="px-5 py-5" scrollClassName="overflow-y-auto" data-raw-content="">
				<ModelContext prompt={run.prompt} />
				{run.items.map((item) => {
					if (item.role === "user" || item.role === "wake")
						return (
							<RawRow
								key={item.id}
								title={item.role === "user" ? "Your message" : "Routine"}
								icon={<MessageSquareIcon className="size-4" />}
								state={clock(item.at)}
								defaultOpen
							>
								<p className="whitespace-pre-wrap text-ui text-ink-2">{item.text}</p>
							</RawRow>
						);
					if (item.role !== "assistant") return null;
					return (
						<div key={item.id} className="flex min-w-0 flex-col gap-4">
							{item.thinking ? (
								<RawRow title="Thinking" icon={<SparklesIcon className="size-4" />} state={clock(item.at)} defaultOpen>
									<p className="whitespace-pre-wrap text-ui text-ink-2">{item.thinking}</p>
								</RawRow>
							) : null}
							{item.text ? (
								<RawRow
									title="Model note"
									icon={<SparklesIcon className="size-4" />}
									state={clock(item.at)}
									defaultOpen
								>
									<Markdown>{item.text}</Markdown>
								</RawRow>
							) : null}
							{item.calls?.map((call) => {
								const result = called.get(call.id)?.result;
								return (
									<RawRow
										key={call.id}
										title={call.name}
										icon={<ToolIcon name={call.name} />}
										summary={toolPreview(call.name, call.args)}
										state={result?.error ? "Failed" : result ? "Done" : "No recorded result"}
									>
										<p className="text-meta text-ink-2">
											{clock(item.at)}
											{result?.durationMs === undefined ? "" : ` · ${(result.durationMs / 1000).toFixed(1)}s`}
										</p>
										{call.name === "bash" && typeof call.args.command === "string" && result ? (
											<Terminal command={call.args.command} output={result.text} />
										) : (
											<>
												<RawValue label="Arguments">{JSON.stringify(call.args)}</RawValue>
												{result ? <RawValue label={result.error ? "Error" : "Result"}>{result.text}</RawValue> : null}
											</>
										)}
									</RawRow>
								);
							})}
							{item.error ? <p className="text-ui text-danger">{item.error}</p> : null}
						</div>
					);
				})}
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	);
}
