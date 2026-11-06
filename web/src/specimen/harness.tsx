/** Fixture-only: an agent hands coding work to Claude Code on the owner's computer, from connecting to its outcome. */
import { SquareIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { HarnessAsks } from "../app/HarnessSession.tsx";
import { ApprovalCard } from "../chat/Approval.tsx";
import { Bubble, Run } from "../chat/Feed.tsx";
import { FolderBrowser } from "../chat/FolderPicker.tsx";
import {
	HarnessCard,
	type HarnessSessionView,
	type HarnessState,
	type HarnessStep,
	HarnessTile,
	HarnessTranscript,
} from "../chat/Harness.tsx";
import { Header } from "../chat/Header.tsx";
import { Line } from "../chat/Line.tsx";
import { Panel, PanelSection } from "../chat/Panel.tsx";
import type { FolderListing, HarnessSessionView as SessionApiView } from "../lib/api.ts";
import { MARA } from "./fixtures.ts";
import { Section } from "./stage.tsx";

const HARNESS = "Claude Code";
const FOLDER = "~/sancho";
const PROMPT =
	'The auth test fails on main (test/auth.spec.ts: "refresh keeps the session"). Find why, fix it with the smallest change, and run that test. Don\'t touch other files unless you must.';
const COMMAND = "npm test -- auth.spec.ts";

const BEFORE_ASK: readonly HarnessStep[] = [
	{ kind: "asked", text: PROMPT },
	{ kind: "read", path: "test/auth.spec.ts" },
	{ kind: "read", path: "src/auth.ts" },
	{
		kind: "thought",
		text: "Refresh compares expiresAt (seconds, from the token) with Date.now() (milliseconds), so every token looks expired.",
	},
	{
		kind: "edit",
		path: "src/auth.ts",
		added: 2,
		removed: 1,
		diff: "-  if (token.expiresAt < Date.now()) {\n+  const now = Math.floor(Date.now() / 1000);\n+  if (token.expiresAt < now) {\n     return refresh(token);\n   }",
	},
];
const AFTER_ASK: readonly HarnessStep[] = [
	{ kind: "decided", command: COMMAND, allowed: true },
	{
		kind: "run",
		command: COMMAND,
		running: false,
		output: " ✓ test/auth.spec.ts (6 tests) 412ms\n Test Files  1 passed (1)\n      Tests  6 passed (6)",
	},
	{ kind: "edit", path: "test/helpers/tokens.ts", added: 3, removed: 1 },
	{
		kind: "said",
		text: "Fixed: refresh compared seconds with milliseconds. src/auth.ts converts once; the 6 auth tests pass. The token helper minted ms too, so I fixed it.",
	},
];
/** Folders as the daemon lists them, for the picker beside the field. */
const browseSample = async (path?: string): Promise<FolderListing> =>
	path === undefined || path === "~" || path === "~/code"
		? {
				path: "~/code",
				parent: "~",
				folders: [
					{ name: "banda", path: "~/code/banda", repo: true, projects: 0 },
					{ name: "clients", path: "~/code/clients", repo: false, projects: 4 },
					{ name: "notes", path: "~/code/notes", repo: false, projects: 0 },
					{ name: "sancho", path: "~/code/sancho", repo: true, projects: 0 },
				],
			}
		: { path, parent: "~/code", folders: [] };

/** The folder browser on sample folders, moving as the owner steps through them. */
function FolderBrowserSample() {
	const [at, setAt] = useState("~/code");
	const onAt = useCallback((path: string) => setAt(path), []);
	return <FolderBrowser at={at} browse={browseSample} onAt={onAt} />;
}

const OUTCOME = "Fixed: refresh compared seconds with milliseconds";

/** What streams in, one every tick, looping: reads, thoughts, runs and edits, as a live session hands them over. */
const STREAMED: readonly HarnessStep[] = [
	{ kind: "read", path: "src/session.ts" },
	{ kind: "thought", text: "The refresh path also mints in milliseconds; the helper must follow." },
	{ kind: "run", command: "npm test -- auth.spec.ts", output: " ✓ refresh keeps the session", running: true },
	{ kind: "edit", path: "test/helpers/tokens.ts", added: 3, removed: 1 },
	{ kind: "read", path: "test/helpers/tokens.ts" },
	{ kind: "run", command: "npm run check", output: "Checked 412 files", running: true },
];

/** One tick of a streaming session: every third tick grows the last run's output, the rest append a step. */
export function grownSteps(steps: readonly HarnessStep[], tick: number): readonly HarnessStep[] {
	let lastRun = -1;
	steps.forEach((step, index) => {
		if (step.kind === "run") lastRun = index;
	});
	if (tick % 3 === 0 && lastRun >= 0) {
		const run = steps[lastRun] as Extract<HarnessStep, { kind: "run" }>;
		const grown = { ...run, output: `${run.output ?? ""}\n ✓ line ${tick} of its output` };
		return steps.map((step, index) => (index === lastRun ? grown : step));
	}
	const next = STREAMED[tick % STREAMED.length] as HarnessStep;
	return [...steps, next];
}

/** The sheet's bounded, following log, with a live stream on demand: a step (or more output) every ~800 ms. */
function StreamingSheet() {
	const [steps, setSteps] = useState<readonly HarnessStep[]>(() => [...BEFORE_ASK]);
	const [streaming, setStreaming] = useState(false);
	useEffect(() => {
		if (!streaming) return;
		let tick = 0;
		const timer = setInterval(() => {
			tick += 1;
			setSteps((prior) => grownSteps(prior, tick));
		}, 800);
		return () => clearInterval(timer);
	}, [streaming]);
	return (
		<div className="flex h-80 flex-col gap-2">
			<div className="flex items-center gap-2">
				<p className="text-meta text-ink-2">Bounded and following, as the sheet holds it:</p>
				<Button size="xs" variant="outline" aria-pressed={streaming} onClick={() => setStreaming((on) => !on)}>
					{streaming ? "Stop streaming" : "Simulate streaming"}
				</Button>
			</div>
			<HarnessTranscript
				session={{ harness: HARNESS, provider: "anthropic", folder: FOLDER, state: "working", steps, elapsed: "0:46" }}
				follow
			/>
		</div>
	);
}

/** A card mid-work, for one state of the gallery: its steps as they would be at that moment. */
const midwork = (steps: readonly HarnessStep[], state: HarnessState, elapsed = "0:12"): HarnessSessionView => ({
	harness: HARNESS,
	provider: "anthropic",
	folder: FOLDER,
	state,
	steps,
	elapsed,
});

const LONG_RUN =
	"cd /Users/sam/sancho && NODE_OPTIONS=--max-old-space-size=4096 npm run build:web -- --mode production --outDir dist/web --sourcemap";

const LONG_DIFF = [
	"--- a/src/auth.ts",
	"+++ b/src/auth.ts",
	"@@ -12,9 +12,10 @@ export async function session(token: Token) {",
	"-  if (token.expiresAt < Date.now()) {",
	"+  const now = Math.floor(Date.now() / 1000);",
	"+  if (token.expiresAt < now) {",
	"     return refresh(token);",
	"   }",
	"   return token;",
	" }",
	"@@ -31,12 +32,12 @@ export function refresh(token: Token) {",
	"-  const grace = 30_000;",
	"+  const grace = 30;",
	"   if (token.expiresAt + grace < nowSeconds()) {",
	"     throw new SessionExpired();",
	"   }",
	"-  return mint(token.user, Date.now() + TTL_MS);",
	"+  return mint(token.user, nowSeconds() + TTL_S);",
	" }",
	"@@ -51,7 +52,7 @@ function mint(user: string, expiresAt: number) {",
	"-  expiresAt: expiresAt,",
	"+  expiresAt, // seconds, as the token says it",
	"   user,",
	" }",
].join("\n");

/** A session as the API says it, for the asks fixtures: only what HarnessAsks reads. */
const askSession = (asks: SessionApiView["asks"]): SessionApiView => ({
	task: 7,
	chat: 1,
	agent: "mara",
	harness: "claude-code",
	service: HARNESS,
	provider: "anthropic",
	folder: FOLDER,
	state: "waiting",
	at: 0,
	steps: [],
	dropped: 0,
	...(asks === undefined ? {} : { asks }),
});

const EXECUTE_ASK = { id: "a1", kind: "execute", command: COMMAND } as const;
const EDIT_ASK = { id: "a2", kind: "edit", command: "src/auth.ts", title: "src/auth.ts", detail: LONG_DIFF } as const;
const FETCH_ASK = { id: "a3", kind: "fetch", command: "https://nodejs.org/api/crypto.html" } as const;
/** Enough folded asks that the "more waiting" line must truncate, never overflow. */
const MANY_ASKS = [
	EXECUTE_ASK,
	EDIT_ASK,
	FETCH_ASK,
	{ id: "a4", kind: "delete", command: "src/old.ts" } as const,
	{ id: "a5", kind: "move", command: "src/a.ts → src/b.ts" } as const,
	{ id: "a6", kind: "execute", command: "npm test" } as const,
	{ id: "a7", kind: "other", command: "something else" } as const,
];

type Step = "connect" | "working" | "waiting" | "done" | "stopped";
const STEPS: readonly { id: Step; label: string }[] = [
	{ id: "connect", label: "Connect" },
	{ id: "working", label: "Working" },
	{ id: "waiting", label: "It asks you" },
	{ id: "done", label: "Done" },
	{ id: "stopped", label: "Stopped" },
];
const order = (step: Step) => STEPS.findIndex((each) => each.id === step);

function sessionAt(step: Step, notes: readonly HarnessStep[]): HarnessSessionView {
	const steps: HarnessStep[] =
		step === "working"
			? [...BEFORE_ASK]
			: step === "waiting"
				? [...BEFORE_ASK, { kind: "waiting", command: COMMAND }]
				: step === "stopped"
					? BEFORE_ASK.slice(0, 4)
					: [...BEFORE_ASK, ...AFTER_ASK];
	const state: HarnessState =
		step === "done" ? "done" : step === "stopped" ? "stopped" : step === "waiting" ? "waiting" : "working";
	// the owner's notes join where they were sent; one sent before the end has been taken by then
	const taken = notes.map((note) =>
		note.kind === "steered" ? { ...note, taken: state === "done" || state === "stopped" } : note,
	);
	return {
		harness: HARNESS,
		provider: "anthropic",
		folder: FOLDER,
		state,
		steps: [...steps, ...taken],
		elapsed: state === "done" ? "1:48" : state === "stopped" ? "0:31" : "0:46",
		outcome: OUTCOME,
	};
}

/** The whole flow in one chat, every control live: connect, approve the ask, steer, answer its ask, stop. */
function Flow() {
	const [step, setStep] = useState<Step>("connect");
	const [notes, setNotes] = useState<HarnessStep[]>([]);
	const [panel, setPanel] = useState(false);
	const session = sessionAt(step, notes);
	const steer = (text: string) => setNotes((prior) => [...prior, { kind: "steered", text, taken: false }]);
	const at = order(step);
	return (
		<div className="flex w-full min-w-0 flex-col gap-4">
			<fieldset className="flex flex-wrap gap-1.5" aria-label="Where in the flow">
				{STEPS.map((each) => (
					<Button
						key={each.id}
						size="xs"
						variant={each.id === step ? "default" : "outline"}
						aria-pressed={each.id === step}
						onClick={() => {
							setStep(each.id);
							if (order(each.id) < order("working")) setNotes([]);
						}}
					>
						{each.label}
					</Button>
				))}
			</fieldset>
			<div className="flex min-w-0 gap-4">
				<div role="log" aria-label="Claude Code flow fixture" className="flex min-w-0 flex-1 flex-col gap-4">
					<Run>
						<Bubble>The auth test is failing on main again. Can you get Claude Code to fix it in the repo?</Bubble>
					</Run>
					<Run who={MARA} time="10:41">
						<Bubble>
							I can hand this to Claude Code in your <code>sancho</code> folder. It isn't connected yet.
						</Bubble>
						<HarnessTile
							agent="Mara"
							harness={HARNESS}
							provider="anthropic"
							about="Anthropic's coding agent, with your Claude sign-in on this computer."
							connected={at > 0 ? FOLDER : undefined}
							on={at > 0}
							onConnect={() => setStep("working")}
							onSwitch={() => {}}
						/>
						{at < 1 ? null : <Bubble>Connected. I've asked Claude Code to fix it; you'll see it work here.</Bubble>}
						{at < 1 ? null : (
							<HarnessCard
								session={session}
								onStop={() => setStep("stopped")}
								onOpen={() => setPanel(true)}
								onSteer={steer}
							/>
						)}
						{step === "waiting" || step === "done" ? (
							<ApprovalCard
								agent={HARNESS}
								what={`Run a command in ${FOLDER}`}
								verb="Run"
								declineLabel="Don't run"
								as="Mara's task"
								object={<Terminal command={COMMAND} output="" />}
								scope="Don't ask again for this session"
								state={step === "done" ? { kind: "done", words: "Ran once" } : { kind: "open" }}
								onApprove={() => setStep("done")}
								onDecline={() => setStep("stopped")}
							/>
						) : null}
					</Run>
					{step === "done" ? (
						<Run who={MARA} time="10:44">
							<Bubble>
								Done. Refresh compared the token's expiry in seconds with the clock in milliseconds, so every token
								looked expired. Claude Code changed <code>src/auth.ts</code> and the token helper; the 6 auth tests
								pass. Want me to open a pull request?
							</Bubble>
						</Run>
					) : null}
					{step === "stopped" ? (
						<>
							<Line icon={SquareIcon}>You stopped Claude Code · 1 file changed so far</Line>
							<Run who={MARA} time="10:43">
								<Bubble>
									Stopped. It had changed <code>src/auth.ts</code> but hadn't run the tests. Should I ask it to finish,
									or leave the change for you?
								</Bubble>
							</Run>
						</>
					) : null}
				</div>
				{panel && at >= 1 ? (
					<Panel name="Mara" onClose={() => setPanel(false)} className="hidden w-80 shrink-0 md:flex">
						<PanelSection title={HARNESS}>
							<HarnessTranscript session={session} onSteer={steer} />
						</PanelSection>
					</Panel>
				) : null}
			</div>
		</div>
	);
}

const AT: Record<HarnessState, Step> = {
	working: "working",
	waiting: "waiting",
	done: "done",
	stopped: "stopped",
	interrupted: "stopped",
	failed: "stopped",
};

export function HarnessSection() {
	return (
		<>
			<Section id="harness-header" title="Delegated activity in the header">
				<Header
					name={MARA.name}
					faces={[MARA]}
					state="working"
					doing="Claude Code is running a command…"
					onActivity={() => {}}
				/>
				<Header
					name={MARA.name}
					faces={[MARA]}
					state="waiting"
					doing="Waiting on you · Claude Code"
					attention
					onActivity={() => {}}
				/>
				<Header
					name={MARA.name}
					faces={[MARA]}
					state="working"
					doing="2 coding sessions running"
					onActivity={() => {}}
				/>
				<Header
					name={MARA.name}
					faces={[MARA]}
					state="working"
					doing="Thinking…"
					attention
					delegated={{ count: 2, waiting: true, onOpen: () => {} }}
					phone
					onActivity={() => {}}
				/>
			</Section>

			<Section
				id="harness"
				title="Claude Code in a chat"
				note="An agent hands coding work to a harness (here Claude Code) on the owner's computer. Connecting picks the folder; the agent starts it without asking; the card follows the work in one line; what reaches the owner is the harness's own asks; the owner steers it in their own words or stops it. Open shows every step."
				wide
			>
				<Flow />
			</Section>
			<Section
				id="harness-states"
				title="A session, every state"
				note="Working and waiting can be steered and stopped. A note waits for the current step, then is taken. A restart never sends the ask again: it says so."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					{(["working", "waiting", "done", "stopped", "interrupted", "failed"] as const).map((state) => {
						const view = sessionAt(
							AT[state],
							state === "working" ? [{ kind: "steered", text: "Also update the changelog", taken: false }] : [],
						);
						return (
							<HarnessCard
								key={state}
								session={{ ...view, state, ...(state === "failed" ? { outcome: "its adapter exited early" } : {}) }}
							/>
						);
					})}
					<HarnessTile
						harness={HARNESS}
						provider="anthropic"
						connected="~/code"
						agents={["Mara", "Sancho"]}
						onEdit={() => {}}
						onDisconnect={() => {}}
					/>
					<HarnessTile
						harness="pi"
						logo="pi"
						about="The minimal coding agent, through banda's own adapter."
						onConnect={() => {}}
					/>
					<HarnessTile
						harness="Goose"
						connected="~/code"
						agents={[]}
						onEdit={() => {}}
						onDisconnect={() => {}}
						onRemove={() => {}}
					/>
					<HarnessTile
						agent="Mara"
						harness={HARNESS}
						provider="anthropic"
						connected="~/code"
						on
						onSwitch={() => {}}
						onEdit={() => {}}
					/>
					<HarnessTile
						agent="Mara"
						harness="Codex"
						provider="openai"
						connected="~/code"
						on={false}
						onSwitch={() => {}}
						onEdit={() => {}}
					/>
					<p className="text-meta text-ink-2">The code folder, as the connect dialog browses it:</p>
					<FolderBrowserSample />
				</div>
			</Section>
			<Section
				id="harness-headlines"
				title="The card's one line"
				note="The card speaks each step in the owner's words: a long command loses its cd prefix and truncates in the middle; a read names the file."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					<HarnessCard
						session={midwork(
							[{ kind: "asked", text: PROMPT }, ...BEFORE_ASK.slice(1, 3), { kind: "run", command: LONG_RUN }],
							"working",
							"0:58",
						)}
						onOpen={() => {}}
					/>
					<HarnessCard
						session={midwork(
							[
								{ kind: "asked", text: PROMPT },
								{ kind: "read", path: "~/sancho/test/auth.spec.ts" },
							],
							"working",
							"0:07",
						)}
						onOpen={() => {}}
					/>
				</div>
			</Section>
			<Section
				id="harness-asks"
				title="Its asks, one at a time"
				note="The oldest ask shows whole; a long command or diff scrolls in a bounded window with Show all; the rest fold to one line until each is reviewed. There is no approve-all."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					<HarnessAsks session={askSession([EXECUTE_ASK])} agentName="Mara" />
					<HarnessAsks session={askSession([EDIT_ASK])} agentName="Mara" />
					<HarnessAsks session={askSession([EXECUTE_ASK, EDIT_ASK, FETCH_ASK])} agentName="Mara" />
					<HarnessAsks session={askSession(MANY_ASKS)} agentName="Mara" />
				</div>
			</Section>
			<Section
				id="harness-panel"
				title="Claude Code in the panel"
				note="Every step, compact: reads as one line, thoughts folded, edits as diffs, commands as terminals, the owner's notes where they went in."
			>
				<div className="flex max-w-md flex-col gap-3">
					<HarnessTranscript
						session={sessionAt("working", [{ kind: "steered", text: "Keep the diff under 10 lines", taken: false }])}
					/>
					<HarnessTranscript session={sessionAt("done", [])} />
					<HarnessTranscript
						session={{
							...sessionAt("working", [
								{ kind: "steered", text: "Also run the linter on what you changed", taken: true, from: "agent" },
							]),
							agent: "Sancho",
							task: 42,
							continues: 41,
						}}
					/>
					<HarnessCard
						session={{ ...sessionAt("stopped", []), agent: "Sancho", task: 43, stoppedBy: "agent" }}
						onOpen={() => {}}
					/>
				</div>
			</Section>
			<Section
				id="harness-sheet"
				title="The steps sheet"
				note="Every step folds to one line; a row opens to the raw command, the diff or the whole text. The sheet opens at the newest step and follows it; scrolling up shows the chat's way back down."
			>
				<div className="flex max-w-md flex-col gap-6">
					<div className="flex flex-col gap-2">
						<p className="text-meta text-ink-2">Folded, as it opens:</p>
						<HarnessTranscript session={sessionAt("done", [])} />
					</div>
					<div className="flex flex-col gap-2">
						<p className="text-meta text-ink-2">A run and a diff opened:</p>
						<HarnessTranscript session={sessionAt("done", [])} defaultOpenSteps={["edit:4", "run:6"]} />
					</div>
					<StreamingSheet />
				</div>
			</Section>
		</>
	);
}
