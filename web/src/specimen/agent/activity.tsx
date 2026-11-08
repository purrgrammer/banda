/** Fixture-only exploration: quiet chat → activity → the recorded stream. No daemon or model requests. */
import {
	ArrowLeftIcon,
	CheckIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	GlobeIcon,
	MoreHorizontalIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
	SearchIcon,
	SparklesIcon,
} from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import {
	ChainOfThought,
	ChainOfThoughtContent,
	ChainOfThoughtHeader,
	ChainOfThoughtSearchResult,
	ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { ModelContext, RawRow, RawValue } from "../../chat/ActivityDetail.tsx";
import { Band } from "../../chat/Band.tsx";
import { Composer } from "../../chat/Composer.tsx";
import { Face } from "../../chat/Face.tsx";
import { Bubble, DaySeparator, Run } from "../../chat/Feed.tsx";
import { ToolIcon, toolPreview } from "../../chat/tool-presentation.tsx";
import { MARA, ROWS } from "../fixtures.ts";
import { Section, StageContext } from "../stage.tsx";

type Scenario = "working" | "finished" | "failed";
type Depth = "activity" | "transcript";
const REQUEST =
	"Find me a direct train from Barcelona to Madrid on Friday morning. Under €60, ideally arriving before noon.";
const ACKNOWLEDGEMENT = "I’ll check the morning trains and compare the fares.";
const REPLY =
	"The 09:00 is the one I’d take: direct, €46, and in Madrid by 11:45. The 08:00 saves €7 if you don’t mind an earlier start. Both basic fares are non-refundable.";
const FAILURE =
	"I found three morning trains, but the fare conditions page didn’t load. I haven’t confirmed the cancellation terms.";
const SYSTEM_PROMPT = `You are Mara, the owner’s travel assistant.
Research options that match the owner’s dates, budget and preferences.
Use the browser to check current departures, fares and fare conditions.
Keep credentials out of tool arguments. Ask before booking or paying.
Use message_user to send the owner a concise recommendation. If a source is unavailable, say what you could not verify.`;
const AVAILABLE_TOOLS = [
	{
		name: "browser_navigate",
		description: "Open an address and read the page snapshot.",
		parameters: {
			type: "object",
			properties: { url: { type: "string", description: "The address to open." } },
			required: ["url"],
		},
	},
	{
		name: "bash",
		description: "Run a shell command in the agent’s computer.",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
	{
		name: "message_user",
		description: "Send a message to the owner.",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
] as const;
const THINKING =
	"The 08:00 train is the cheapest of the three direct options. The 09:00 departure costs €7 more and arrives before noon. I’ll compare the fare conditions before recommending one.";
const COMPARE_COMMAND = `python3 - <<'PY'
trains = [("08:00", "10:45", 39), ("09:00", "11:45", 46), ("10:00", "12:45", 52)]
matches = [train for train in trains if train[1] < "12:00" and train[2] < 60]
for departure, arrival, price in matches:
    print(f"{departure} → {arrival} · €{price}")
print(f"{len(matches)} trains arrive before noon and cost less than €60.")
PY`;
const COMPARE_OUTPUT =
	"08:00 → 10:45 · €39\n09:00 → 11:45 · €46\n2 trains arrive before noon and cost less than €60.\n";
const STEPS = [
	{
		title: "Looking up direct trains",
		description: "Barcelona → Madrid · Friday 14 November",
		source: "Renfe",
		tool: "browser_navigate",
		input: { url: "https://www.renfe.com/es/en" },
		output: "Barcelona Sants → Madrid Puerta de Atocha\nFriday 14 November · 1 adult\nDirect trains available",
		time: "10:42:02",
		duration: "4s",
	},
	{
		title: "Reading departures and fares",
		description: "3 morning departures, from €39",
		source: "Trainline",
		tool: "browser_navigate",
		input: { url: "https://www.thetrainline.com/en/train-times/barcelona-to-madrid" },
		output: JSON.stringify({
			route: "Barcelona → Madrid",
			currency: "EUR",
			departures: [
				{ departure: "08:00", arrival: "10:45", direct: true, price: 39 },
				{ departure: "09:00", arrival: "11:45", direct: true, price: 46 },
				{ departure: "10:00", arrival: "12:45", direct: true, price: 52 },
			],
		}),
		time: "10:42:06",
		duration: "6s",
	},
	{
		title: "Comparing the options",
		description: "Departure times, prices and fare conditions",
		source: undefined,
		tool: "browser_navigate",
		input: { url: "https://www.renfe.com/es/en/travel/prepare-your-trip/ave-and-largedistance/el-billete" },
		output: "Basic fare · seat included\nChanges carry a fee. No refund.\nPrices checked for one adult, one way.",
		time: "10:42:12",
		duration: "8s",
	},
] as const;

export function ActivitySection() {
	return (
		<Section
			id="activity"
			note="Status → activity → raw details. Click the status under Mara’s name. Fixture data only; Play stream simulates new output."
			bleed
			wide
		>
			<ActivityChat />
		</Section>
	);
}

/** A focused review link, alongside the same specimen in the full collection. */
export function ActivityPreview() {
	const [scheme, setScheme] = useState("light");
	const [width, setWidth] = useState("desktop");
	return (
		<StageContext.Provider
			value={{ scheme: scheme === "dark" ? "dark" : "light", width: width === "phone" ? "phone" : "desktop" }}
		>
			<div style={{ colorScheme: scheme }} className="flex h-svh flex-col bg-paper-2 text-ink">
				<header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft bg-paper px-4 py-3">
					<span className="text-meta text-ink-2">Activity · specimen</span>
					<div className="ml-auto flex flex-wrap items-center gap-2">
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
							<a href="#/specimen/activity/recorded">Recorded conversation</a>
						</Button>
					</div>
				</header>
				<div
					className={cn(
						"mx-auto flex min-h-0 w-full flex-1 overflow-hidden",
						width === "phone" ? "max-w-[390px] border-x border-line-soft" : "max-w-[1440px]",
					)}
				>
					{width === "desktop" ? (
						<div className="hidden shrink-0 lg:flex">
							<Band rows={ROWS} selected="mara" />
						</div>
					) : null}
					<ActivityChat />
				</div>
			</div>
		</StageContext.Provider>
	);
}

export function ActivityChat() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	const [scenario, setScenario] = useState<Scenario>("working");
	const [open, setOpen] = useState(false);
	const [depth, setDepth] = useState<Depth>("activity");
	const [playing, setPlaying] = useState(false);
	const [tick, setTick] = useState(16);
	const [scheme, setScheme] = useState("light");
	const root = useRef<HTMLDivElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const drill = (next: Depth) => {
		setDepth(next);
		requestAnimationFrame(() => heading.current?.focus());
	};
	const done = scenario === "finished";
	const failed = scenario === "failed";
	const working = !done && !failed;
	const visibleSteps = done || failed ? 3 : tick < 5 ? 1 : tick < 11 ? 2 : 3;
	const thinking = done || failed ? THINKING : THINKING.slice(0, Math.max(0, (tick - 11) * 16));
	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => setTick((value) => value + 1), 650);
		return () => clearInterval(timer);
	}, [playing]);
	useEffect(() => {
		if (tick < 32 || !playing) return;
		setScenario("finished");
		setPlaying(false);
	}, [tick, playing]);
	const select = (value: string) => {
		setScenario(value as Scenario);
		setPlaying(false);
		setTick(16);
	};
	const show = (next: Depth = "activity") => {
		setDepth(next);
		setScheme(root.current ? getComputedStyle(root.current).colorScheme : "light");
		setOpen(true);
	};
	const status = failed
		? "Couldn’t check fare conditions"
		: done
			? "Finished"
			: visibleSteps === 1
				? "Looking up trains…"
				: visibleSteps === 2
					? "Reading departure times…"
					: "Comparing the options…";
	return (
		<div ref={root} className="flex min-w-0 flex-1 flex-col bg-paper" data-activity-chat="">
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line-soft bg-paper-2 px-3 py-2">
				<Tabs value={scenario} onValueChange={select}>
					<TabsList aria-label="Fixture state">
						<TabsTrigger value="working">Working</TabsTrigger>
						<TabsTrigger value="finished">Finished</TabsTrigger>
						<TabsTrigger value="failed">Failure</TabsTrigger>
					</TabsList>
				</Tabs>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						if (playing) setPlaying(false);
						else {
							if (!working || tick >= 32) {
								setTick(0);
								setScenario("working");
							}
							setPlaying(true);
						}
					}}
				>
					{playing ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
					{playing ? "Pause stream" : "Play stream"}
				</Button>
				<span className="w-full text-meta text-ink-2">Fixture data · click Mara’s status to look inside</span>
			</div>
			<Sheet
				open={open}
				onOpenChange={(value) => {
					if (value) show();
					else setOpen(false);
				}}
			>
				<header className="flex h-16 shrink-0 items-center gap-3 border-b border-line-soft px-4">
					<Face face={MARA.face} name={MARA.name} size="message" state={working ? "working" : "idle"} />
					<div className="flex min-w-0 flex-col items-start">
						<span className="text-heading font-semibold">Mara</span>
						<SheetTrigger asChild>
							<button
								type="button"
								className="flex max-w-full items-center gap-1 rounded-field text-left text-meta text-ink-2 hover:text-ink"
								aria-label="View current activity"
							>
								{working ? (
									<Shimmer as="span" duration={2.4} className="truncate">
										{status}
									</Shimmer>
								) : (
									<span className="truncate">{status}</span>
								)}
								<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
							</button>
						</SheetTrigger>
					</div>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto flex max-w-[44rem] flex-col gap-6 px-4 py-6">
						<DaySeparator>Today</DaySeparator>
						<Run time="10:41">
							<Bubble copy={REQUEST}>{REQUEST}</Bubble>
						</Run>
						<Run who={MARA} time="10:42" compact>
							<Bubble copy={ACKNOWLEDGEMENT} onActivity={() => show()}>
								{ACKNOWLEDGEMENT}
							</Bubble>
						</Run>
						{done ? (
							<Run who={MARA} time="10:43" compact>
								<Bubble copy={REPLY} onActivity={() => show()}>
									{REPLY}
								</Bubble>
							</Run>
						) : null}
						{failed ? (
							<Run who={MARA} compact>
								<Bubble copy={FAILURE} onActivity={() => show()}>
									{FAILURE}
								</Bubble>
							</Run>
						) : null}
					</div>
				</div>
				<div className="mx-auto w-full max-w-[44rem] px-3 pb-3">
					<Composer to="Mara" state={working ? "working" : "ready"} />
				</div>
				<SheetContent
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						heading.current?.focus();
					}}
					style={{ colorScheme: scheme }}
					className={cn(
						"gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[520px]",
						phone && "data-[side=right]:sm:max-w-[390px]",
					)}
				>
					<SheetHeader className="gap-2 border-b border-line-soft pr-12">
						{depth !== "activity" ? (
							<Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => drill("activity")}>
								<ArrowLeftIcon data-icon="inline-start" />
								Activity
							</Button>
						) : null}
						<SheetTitle ref={heading} tabIndex={-1} className="outline-none">
							{depth === "activity" ? "Activity" : "Full transcript"}
						</SheetTitle>
						<SheetDescription>Mara · {done ? "Finished · 32s" : failed ? "Stopped · 18s" : "Working"}</SheetDescription>
					</SheetHeader>
					{depth === "activity" ? (
						<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6">
							<div className="mb-7 flex flex-col gap-2">
								<p className="text-body font-medium">A morning train to Madrid</p>
								<p className="text-ui text-ink-2">Friday 14 November · direct · under €60</p>
							</div>
							<ChainOfThought defaultOpen>
								<ChainOfThoughtHeader>{done ? "How the work was done" : "What’s happening"}</ChainOfThoughtHeader>
								<ChainOfThoughtContent>
									{STEPS.slice(0, visibleSteps).map((step, index) => {
										const active = working && index === visibleSteps - 1;
										const error = failed && index === 2;
										return (
											<ChainOfThoughtStep
												key={step.title}
												status={active ? "active" : "complete"}
												icon={error ? CircleAlertIcon : active ? (index === 2 ? SparklesIcon : SearchIcon) : CheckIcon}
												label={
													<button
														type="button"
														onClick={() => drill("transcript")}
														className="flex min-h-11 w-full flex-col gap-2 rounded-field px-1 py-2 text-left hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2"
														aria-label={`Inspect ${step.title.toLowerCase()}`}
													>
														<span className="flex w-full items-center justify-between gap-3">
															<span>
																{step.title}
																{active ? "…" : ""}
															</span>
															<ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
														</span>
														<span className="text-meta text-ink-2">
															{error
																? "The fare conditions page didn’t respond."
																: active && index === 1
																	? "Checking the timetable and published prices"
																	: step.description}
														</span>
														{step.source ? (
															<span className="flex flex-wrap gap-2">
																<ChainOfThoughtSearchResult>
																	<GlobeIcon aria-hidden="true" />
																	{step.source}
																</ChainOfThoughtSearchResult>
															</span>
														) : null}
														<span className={cn("text-meta", error ? "text-danger" : "text-ink-3")}>
															{error ? "Failed · view error" : active ? "In progress" : `Done · ${step.duration}`}
														</span>
													</button>
												}
											/>
										);
									})}
								</ChainOfThoughtContent>
							</ChainOfThought>
						</div>
					) : (
						<RawStream visibleSteps={visibleSteps} thinking={thinking} working={working} failed={failed} tick={tick} />
					)}
					<div className="flex shrink-0 items-center justify-between gap-2 border-t border-line-soft bg-paper-2 px-4 py-2">
						<span className="text-meta text-ink-2">Simulated stream</span>
						<div className="flex gap-1">
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Replay work"
								onClick={() => {
									setTick(0);
									setScenario("working");
									setPlaying(true);
								}}
							>
								<RotateCcwIcon />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									if (done || failed) {
										setTick(0);
										setScenario("working");
									}
									setPlaying(!playing);
								}}
							>
								{playing ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
								{playing ? "Pause" : "Play"}
							</Button>
						</div>
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}

function RawStream({
	visibleSteps,
	thinking,
	working,
	failed,
	tick,
}: {
	visibleSteps: number;
	thinking: string;
	working: boolean;
	failed: boolean;
	tick: number;
}) {
	return (
		<Conversation aria-label="Recorded activity" aria-live="off">
			<ConversationContent className="px-5 py-5" scrollClassName="overflow-y-auto" data-raw-content="">
				<ModelContext prompt={{ system: SYSTEM_PROMPT, tools: AVAILABLE_TOOLS }} />
				<RawRow title="Your message" icon={<MoreHorizontalIcon className="size-4" />} state="10:41:58" defaultOpen>
					<p className="text-ui text-ink-2">{REQUEST}</p>
				</RawRow>
				<RawRow
					title="message_user"
					icon={<ToolIcon name="message_user" />}
					summary={toolPreview("message_user", { text: ACKNOWLEDGEMENT })}
					state="Delivered"
				>
					<RawValue label="Arguments">{JSON.stringify({ text: ACKNOWLEDGEMENT }, null, 2)}</RawValue>
					<RawValue label="Result">Message delivered.</RawValue>
				</RawRow>
				{STEPS.slice(0, visibleSteps).map((step, index) => {
					const active = working && index === visibleSteps - 1;
					const error = failed && index === 2;
					const navigating = active && (index !== 2 || tick < 29);
					return (
						<div key={step.title} className="flex flex-col gap-4 pb-6">
							{index === 2 ? (
								<RawRow
									title="Thinking"
									icon={<SparklesIcon className="size-4" />}
									state={active && tick < 27 ? "Streaming" : "Done"}
									defaultOpen
								>
									<p className="whitespace-pre-wrap text-ui leading-relaxed text-ink-2" data-thinking="">
										{thinking || "Waiting for reasoning text…"}
									</p>
								</RawRow>
							) : null}
							{index !== 2 || !active || tick >= 27 ? (
								<RawRow
									title={step.tool}
									icon={<ToolIcon name={step.tool} />}
									summary={toolPreview(step.tool, step.input)}
									state={error ? "Failed" : navigating ? "Running" : "Done"}
									defaultOpen
								>
									<p className="text-meta text-ink-3">
										{step.time} · {step.duration}
									</p>
									<RawValue label="Arguments">{JSON.stringify(step.input, null, 2)}</RawValue>
									{error ? (
										<RawValue label="Error">
											Navigation failed: net::ERR_CONNECTION_RESET. No page content was returned.
										</RawValue>
									) : navigating ? (
										<p className="text-meta text-ink-2" role="status">
											Waiting for the page…
										</p>
									) : (
										<RawValue label="Result">{step.output}</RawValue>
									)}
								</RawRow>
							) : null}
							{index === 2 && !failed && (!working || tick >= 29) ? (
								<RawRow
									title="bash"
									icon={<ToolIcon name="bash" />}
									summary={toolPreview("bash", { command: COMPARE_COMMAND })}
									state={working ? "Running" : "Done"}
									defaultOpen
								>
									<Terminal
										command={COMPARE_COMMAND}
										output={working ? COMPARE_OUTPUT.slice(0, (tick - 28) * 30) : COMPARE_OUTPUT}
										isStreaming={working}
									/>
								</RawRow>
							) : null}
						</div>
					);
				})}
				{!working ? (
					<>
						<RawRow title="Model note" icon={<SparklesIcon className="size-4" />} state="Not sent to you">
							<p className="text-ui text-ink-2">
								{failed
									? "Fare conditions were unavailable. Report the options with that caveat."
									: "Comparison complete. Send the recommendation to the owner."}
							</p>
						</RawRow>
						<RawRow
							title="message_user"
							icon={<ToolIcon name="message_user" />}
							summary={toolPreview("message_user", { text: failed ? FAILURE : REPLY })}
							state="Delivered"
							defaultOpen
						>
							<RawValue label="Arguments">{JSON.stringify({ text: failed ? FAILURE : REPLY }, null, 2)}</RawValue>
							<RawValue label="Result">Message delivered.</RawValue>
						</RawRow>
					</>
				) : null}
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	);
}
