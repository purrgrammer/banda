/** Fixture-only: an agent hands coding work to Claude Code on the owner's computer, from connecting to its outcome. */
import { SquareIcon } from "lucide-react";
import { useState } from "react";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { ApprovalCard } from "../chat/Approval.tsx";
import { Bubble, Run } from "../chat/Feed.tsx";
import {
	HarnessCard,
	HarnessConnectCard,
	type HarnessSessionView,
	type HarnessState,
	type HarnessStep,
	HarnessTranscript,
} from "../chat/Harness.tsx";
import { Line } from "../chat/Line.tsx";
import { Panel, PanelSection } from "../chat/Panel.tsx";
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
const OUTCOME = "Fixed: refresh compared seconds with milliseconds";

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
						<HarnessConnectCard
							agent="Mara"
							harness={HARNESS}
							folder={FOLDER}
							connected={at > 0 ? FOLDER : undefined}
							on={at > 0}
							onConnect={() => setStep("working")}
							onDismiss={() => {}}
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
					{(["working", "waiting", "done", "stopped", "interrupted"] as const).map((state) => {
						const view = sessionAt(
							AT[state],
							state === "working" ? [{ kind: "steered", text: "Also update the changelog", taken: false }] : [],
						);
						return <HarnessCard key={state} session={{ ...view, state }} />;
					})}
					<HarnessConnectCard agent="Mara" harness={HARNESS} />
					<HarnessConnectCard
						agent="Mara"
						harness={HARNESS}
						connected={FOLDER}
						on
						onSwitch={() => {}}
						onDisconnect={() => {}}
					/>
					<HarnessConnectCard
						agent="Mara"
						harness={HARNESS}
						connected={FOLDER}
						on={false}
						onSwitch={() => {}}
						onDisconnect={() => {}}
					/>
					<HarnessConnectCard harness={HARNESS} />
					<HarnessConnectCard
						harness="Codex"
						about="OpenAI's coding agent, with your sign-in on this computer."
						folded
					/>
					<HarnessConnectCard harness={HARNESS} connected={FOLDER} onDisconnect={() => {}} />
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
				</div>
			</Section>
		</>
	);
}
