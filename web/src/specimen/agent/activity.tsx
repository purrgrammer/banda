/**
 * Activity: the app's own sheet (`app/Activity.tsx`) over a fixture transcript, opened from the chat's status line and
 * a message's activity control, as in the app. The story: a morning train to Madrid, working, finished or failed, and
 * played as a stream by growing the transcript. No daemon and no model requests.
 */
import { PauseIcon, PlayIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { ActivitySheet } from "../../app/Activity.tsx";
import { Band } from "../../chat/Band.tsx";
import { Bubble, DaySeparator, Run } from "../../chat/Feed.tsx";
import type { Block, ChatPrompt, Item, RunningTool } from "../../lib/api.ts";
import type { Transcript } from "../../lib/transcript.ts";
import { MARA, ROWS } from "../fixtures.ts";
import { ChatScreen } from "../screens/screens.tsx";
import { Section, StageContext } from "../stage.tsx";

/** A transcript as the app's hook would hold it, from items alone: loaded, with nothing older, or live with a run on. */
export function transcriptOf(
	items: readonly Item[],
	live?: { readonly input: number; readonly partial?: readonly Block[]; readonly running?: readonly RunningTool[] },
): Transcript {
	return {
		items,
		waits: [],
		queued: [],
		busy: live !== undefined,
		input: live?.input,
		running: live?.running ?? [],
		partial: live?.partial ?? [],
		thinking: live?.partial?.some((block) => block.type === "thinking" && block.endedAt === undefined) ?? false,
		older: false,
		loadOlder: async () => {},
		loaded: true,
		missing: false,
	};
}

type Scenario = "working" | "finished" | "failed";
const CHAT = 1;
const REQUEST =
	"Find me a direct train from Barcelona to Madrid on Friday morning. Under €60, ideally arriving before noon.";
const ACKNOWLEDGEMENT = "I’ll check the morning trains and compare the fares.";
const REPLY =
	"The 09:00 is the one I’d take: direct, €46, and in Madrid by 11:45. The 08:00 saves €7 if you don’t mind an earlier start. Both basic fares are non-refundable.";
const FAILURE =
	"I found three morning trains, but the fare conditions page didn’t load. I haven’t confirmed the cancellation terms.";
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
const FARES_URL = "https://www.renfe.com/es/en/travel/prepare-your-trip/ave-and-largedistance/el-billete";

export const PROMPT: ChatPrompt = {
	system: `You are Mara, the owner’s travel assistant.
Research options that match the owner’s dates, budget and preferences.
Use the browser to check current departures, fares and fare conditions.
Keep credentials out of tool arguments. Ask before booking or paying.
Use message_user to send the owner a concise recommendation. If a source is unavailable, say what you could not verify.`,
	tools: [
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
	],
};

/** Friday 14 November 2026, 10:41:58, and the seconds after. */
const T0 = Date.UTC(2026, 10, 13, 9, 41, 58);
const at = (seconds: number) => T0 + seconds * 1000;
const round = (
	id: number,
	seconds: number,
	call: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> },
	result: { readonly text: string; readonly error?: boolean; readonly durationMs?: number },
	thinking?: string,
): readonly Item[] => [
	{
		id,
		role: "assistant",
		stop: "toolUse",
		text: "",
		at: at(seconds),
		calls: [call],
		...(thinking ? { thinking } : {}),
	},
	{
		id: id + 1,
		role: "tool",
		call: call.id,
		name: call.name,
		text: result.text,
		error: result.error ?? false,
		at: at(seconds + (result.durationMs ?? 500) / 1000),
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
	},
];

/** The work up to the fare conditions page: the two steps every scenario shares, then the comparison. */
const OPENING: readonly Item[] = [
	{ id: 1, role: "user", text: REQUEST, at: at(0) },
	...round(2, 2, { id: "m1", name: "message_user", args: { text: ACKNOWLEDGEMENT } }, { text: "Sent." }),
	...round(
		4,
		4,
		{ id: "b1", name: "browser_navigate", args: { url: "https://www.renfe.com/es/en" } },
		{
			text: "Barcelona Sants → Madrid Puerta de Atocha\nFriday 14 November · 1 adult\nDirect trains available",
			durationMs: 4000,
		},
	),
	...round(
		6,
		8,
		{
			id: "b2",
			name: "browser_navigate",
			args: { url: "https://www.thetrainline.com/en/train-times/barcelona-to-madrid" },
		},
		{
			text: JSON.stringify({
				route: "Barcelona → Madrid",
				currency: "EUR",
				departures: [
					{ departure: "08:00", arrival: "10:45", direct: true, price: 39 },
					{ departure: "09:00", arrival: "11:45", direct: true, price: 46 },
					{ departure: "10:00", arrival: "12:45", direct: true, price: 52 },
				],
			}),
			durationMs: 6000,
		},
	),
];
const COMPARISON: readonly Item[] = round(
	8,
	14,
	{ id: "c1", name: "bash", args: { command: COMPARE_COMMAND } },
	{ text: COMPARE_OUTPUT, durationMs: 1200 },
	THINKING,
);
const FINISHED: readonly Item[] = [
	...OPENING,
	...COMPARISON,
	...round(
		10,
		16,
		{ id: "b3", name: "browser_navigate", args: { url: FARES_URL } },
		{
			text: "Basic fare · seat included\nChanges carry a fee. No refund.\nPrices checked for one adult, one way.",
			durationMs: 8000,
		},
	),
	...round(12, 25, { id: "m2", name: "message_user", args: { text: REPLY } }, { text: "Sent." }),
	{ id: 14, role: "assistant", stop: "stop", text: "", at: at(32) },
];
const FAILED: readonly Item[] = [
	...OPENING,
	...COMPARISON,
	...round(
		10,
		16,
		{ id: "b3", name: "browser_navigate", args: { url: FARES_URL } },
		{
			text: "Navigation failed: net::ERR_CONNECTION_RESET. No page content was returned.",
			error: true,
			durationMs: 2000,
		},
	),
	...round(12, 18, { id: "m2", name: "message_user", args: { text: FAILURE } }, { text: "Sent." }),
	{
		id: 14,
		role: "assistant",
		stop: "error",
		text: "",
		error: "The answer was cut short: the provider returned 529 (overloaded).",
		at: at(19),
	},
];

/** The run in progress at a moment of the stream: what is recorded, and what is still being generated. */
function working(tick: number): { transcript: Transcript; doing: string } {
	if (tick < 5)
		return {
			transcript: transcriptOf(OPENING.slice(0, 4), {
				input: 1,
				running: [{ call: "b1", name: "browser_navigate", output: "", doing: "Opening renfe.com" }],
			}),
			doing: "Looking up trains…",
		};
	if (tick < 11)
		return {
			transcript: transcriptOf(OPENING.slice(0, 6), {
				input: 1,
				running: [{ call: "b2", name: "browser_navigate", output: "", doing: "Opening thetrainline.com" }],
			}),
			doing: "Reading departure times…",
		};
	const thought = THINKING.slice(0, Math.max(0, (tick - 11) * 16));
	return {
		transcript: transcriptOf(OPENING, {
			input: 1,
			partial: [
				{
					type: "thinking",
					text: thought,
					startedAt: at(12),
					...(thought.length < THINKING.length ? {} : { endedAt: at(14) }),
				},
				...(thought.length < THINKING.length
					? []
					: [
							{ type: "tool" as const, text: "", call: { id: "c1", name: "bash", args: { command: COMPARE_COMMAND } } },
						]),
			],
		}),
		doing: "Comparing the options…",
	};
}

const SCENES: Readonly<Record<Exclude<Scenario, "working">, { transcript: Transcript; doing?: string }>> = {
	finished: { transcript: transcriptOf(FINISHED) },
	failed: { transcript: transcriptOf(FAILED), doing: "Couldn’t check fare conditions" },
};

/** The chat with its activity: the scenario and the stream are the specimen's controls above it. */
export function ActivityChat() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	const [scenario, setScenario] = useState<Scenario>("working");
	const [playing, setPlaying] = useState(false);
	const [tick, setTick] = useState(16);
	const [open, setOpen] = useState<{ anchor?: number }>();
	const [scheme, setScheme] = useState("light");
	const root = useRef<HTMLDivElement>(null);
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
	const scene = scenario === "working" ? working(tick) : SCENES[scenario];
	const live = scenario === "working";
	const show = (anchor?: number) => {
		setScheme(root.current ? getComputedStyle(root.current).colorScheme : "light");
		setOpen(anchor === undefined ? {} : { anchor });
	};
	const play = () => {
		if (playing) return setPlaying(false);
		if (!live || tick >= 32) {
			setTick(0);
			setScenario("working");
		}
		setPlaying(true);
	};
	return (
		<div ref={root} className="flex min-w-0 flex-1 flex-col bg-paper" data-activity-chat="">
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line-soft bg-paper-2 px-3 py-2">
				<Tabs
					value={scenario}
					onValueChange={(value) => {
						setScenario(value as Scenario);
						setPlaying(false);
						setTick(16);
					}}
				>
					<TabsList aria-label="Scenario">
						<TabsTrigger value="working">Working</TabsTrigger>
						<TabsTrigger value="finished">Finished</TabsTrigger>
						<TabsTrigger value="failed">Failure</TabsTrigger>
					</TabsList>
				</Tabs>
				<Button variant="ghost" size="sm" onClick={play}>
					{playing ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
					{playing ? "Pause stream" : "Play stream"}
				</Button>
			</div>
			<ChatScreen
				name={MARA.name}
				faces={[MARA]}
				state={live ? "working" : "idle"}
				doing={scene.doing}
				onActivity={() => show()}
			>
				<DaySeparator>Today</DaySeparator>
				<Run time="10:41">
					<Bubble copy={REQUEST}>{REQUEST}</Bubble>
				</Run>
				<Run who={MARA} time="10:42" compact>
					<Bubble copy={ACKNOWLEDGEMENT} onActivity={() => show(2)}>
						{ACKNOWLEDGEMENT}
					</Bubble>
				</Run>
				{scenario === "finished" ? (
					<Run who={MARA} time="10:42" compact>
						<Bubble copy={REPLY} onActivity={() => show(12)}>
							{REPLY}
						</Bubble>
					</Run>
				) : null}
				{scenario === "failed" ? (
					<Run who={MARA} time="10:42" compact>
						<Bubble copy={FAILURE} onActivity={() => show(12)}>
							{FAILURE}
						</Bubble>
					</Run>
				) : null}
			</ChatScreen>
			{open === undefined ? null : (
				<ActivitySheet
					targets={[{ chat: CHAT, name: MARA.name, ...open }]}
					source={{ chat: CHAT, transcript: scene.transcript, prompt: PROMPT }}
					onClose={() => setOpen(undefined)}
					style={{ colorScheme: scheme, ...(phone ? { maxWidth: 390 } : {}) }}
				/>
			)}
		</div>
	);
}

export function ActivitySection() {
	return (
		<Section
			id="activity"
			note="What an agent did, from the status line or a message. Play stream grows the transcript as a run would."
			bleed
			wide
		>
			<ActivityChat />
		</Section>
	);
}

/** A page of its own, for a browser test and a focused look. */
export function ActivityPreview() {
	const [scheme, setScheme] = useState("light");
	const [width, setWidth] = useState("desktop");
	return (
		<StageContext.Provider
			value={{ scheme: scheme === "dark" ? "dark" : "light", width: width === "phone" ? "phone" : "desktop" }}
		>
			<div style={{ colorScheme: scheme }} className="flex h-svh flex-col bg-paper-2 text-ink">
				<header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft bg-paper px-4 py-3">
					<a href="#/specimen?section=activity" className="text-meta text-ink-2 hover:text-ink">
						Activity · specimen
					</a>
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
