/** Product acceptance journeys. Prompts are inputs; checkpoints are evaluator-only evidence. */
export type Step = { id: string; action: string; prompt?: string; checkpoints: string[] };
export type Journey = { id: string; title: string; requires: string[]; steps: Step[] };
const step = (id: string, action: string, checkpoints: string[], prompt?: string): Step => ({
	id,
	action,
	checkpoints,
	...(prompt ? { prompt } : {}),
});
export const journeys: Journey[] = [
	{
		id: "first-use",
		title: "First use and progressive navigation",
		requires: ["Fresh home; no provider configured"],
		steps: [
			step("setup", "Open the app and connect a disposable provider through the UI.", [
				"Sancho and Settings are reachable; no empty Library, Groups or Agents sections.",
				"On phone, open the navigation drawer, More, then all work; close the work sheet and reopen navigation. Taps and keyboard focus remain usable.",
				"Provider choice and sign-in are understandable without model IDs or CLI intervention.",
			]),
			step(
				"answer",
				"Send a useful first request in the main conversation.",
				[
					"A useful answer arrives, and its working/failed state is legible.",
					"A short answer creates no task dashboard or unnecessary navigation.",
				],
				"Help me plan a simple vegetarian dinner for two using rice, chickpeas and tomatoes. Give me one recipe and a short cooking order.",
			),
			step("identity", "Change Sancho's name and face through conversation details, then reload.", [
				"Identity controls are discoverable from the conversation header.",
				"The accepted identity survives reload; Home remains unambiguous.",
			]),
			step("failure", "Disconnect the test provider in Settings, attempt a message, then reconnect through the app.", [
				"Failure has a visible recovery action; draft and conversation are retained.",
				"The next message uses the restored provider.",
			]),
		],
	},
	{
		id: "work",
		title: "Delegate, steer, stop and return",
		requires: ["Connected provider; disposable workspace"],
		steps: [
			step(
				"delegate",
				"Delegate a substantial task.",
				[
					"Progress is plain language, with a task card only when warranted.",
					"Home exposes tracked work without a separate Work navigation item.",
				],
				"Compare three approaches to organising a small community book exchange. Work through costs, accessibility, upkeep and a practical launch plan. Keep the total budget under €200; do not contact anyone or buy anything.",
			),
			step(
				"steer",
				"While work is running, correct its constraints.",
				[
					"The correction targets the current task and is reflected in the result.",
					"No duplicate unrelated task is implied.",
				],
				"Change the budget to €80 and assume there is no permanent indoor space.",
			),
			step("stop", "Stop active work in the app, then inspect its task details.", [
				"Stop is reachable and the resulting state is accurate.",
				"Completed findings remain readable and helpers are shown within the task.",
			]),
			step("return", "Reload, leave and return; inspect all work and deliberately resume if offered.", [
				"Interrupted, paused, completed and running states are distinguishable.",
				"History is accessible even when there is no active work.",
			]),
		],
	},
	{
		id: "artifacts",
		title: "Artifact discovery, editing and versions",
		requires: ["Connected provider; working disposable box"],
		steps: [
			step(
				"create",
				"Ask for a reusable work product.",
				[
					"Artifact opens from its conversation card.",
					"Library appears only after an artifact exists, with an understandable discovery cue.",
				],
				"Create and publish a plain-text packing checklist for a three-day family trip. Include a separate section for medicines and documents.",
			),
			step("edit", "Open the artifact, add an owner-written line and save.", [
				"Save state is explicit; returning to the conversation preserves context.",
				"Desktop can show it beside chat; phone has a clear return path.",
			]),
			step(
				"concurrent",
				"Ask for an update while editing the same artifact in another view.",
				[
					"Concurrent owner and agent edits are retained or a conflict is explained.",
					"No unacknowledged owner changes disappear.",
				],
				"Update that checklist for rainy weather, keeping my additions.",
			),
			step("restore", "Inspect versions, restore an earlier version and find it through Library after reload.", [
				"Current version and restored content are unambiguous.",
				"Library retrieves it independently of conversation history.",
			]),
			step("empty", "Remove the last artifact through the app.", [
				"Removal is explicit; stale links explain what happened.",
				"Previously revealed Library remains stable with a useful empty state.",
			]),
		],
	},
	{
		id: "decisions",
		title: "Questions, approvals and uncertain sends",
		requires: [
			"Disposable stand-in service; no real recipient or purchase",
			"Fault fixture capable of uncertain external outcome",
		],
		steps: [
			step(
				"ask",
				"Request a choice before further work.",
				[
					"Question appears in conversation and Inbox as the same unresolved decision.",
					"Answering either location resolves both, including after reconnect.",
				],
				"Help choose a book-exchange launch date. Ask me to choose Saturday morning or Sunday afternoon before making the plan. Do not schedule or send anything.",
			),
			step("draft", "Use a disposable connected service to request a send to its test recipient.", [
				"Exact recipient, content and consequences are visible.",
				"Edit requires review of the revised effect; decline sends nothing.",
			]),
			step("approve", "Approve a separate test draft through the app, then revoke its permission.", [
				"Only the reviewed effect executes; floor actions use required authentication.",
				"Revocation is discoverable in Settings and affects subsequent work.",
			]),
			step("uncertain", "Inject a failure after the stand-in accepts a send and before completion is recorded.", [
				"UI reports uncertainty rather than success.",
				"Recovery requires an explicit decision and does not silently duplicate the send.",
			]),
		],
	},
	{
		id: "routines-goals",
		title: "Routines, goals and quiet return visits",
		requires: ["Connected provider; disposable workspace; keep instance running for scheduled wake"],
		steps: [
			step(
				"goal",
				"Propose an ongoing responsibility.",
				[
					"Goal is reviewed before acceptance, with an accepted-state receipt.",
					"It is discoverable through Home's work view.",
				],
				"I'd like to organise a community book exchange this month. Propose a goal for it, but let me review it before it takes effect.",
			),
			step(
				"routine",
				"Request a short-lived reminder and review the actual schedule.",
				[
					"Review states when it runs, what it does and where results arrive.",
					"Next run and pause controls are available outside old messages.",
				],
				"Propose a one-time reminder five minutes from now to check the book-exchange plan. Send the reminder to this conversation; let me review the routine first.",
			),
			step("return", "Leave the app and return after the wake; inspect Inbox and routine history.", [
				"Useful result becomes an unread conversation; no duplicate wake is implied.",
				"Upcoming, completed and failed runs are understandable.",
			]),
			step("pause", "Pause a test routine and all work, reload, then resume deliberately.", [
				"Scope of each pause is explicit and persists.",
				"Completing or ending the goal explains effects on associated routines.",
			]),
		],
	},
	{
		id: "agents-memory",
		title: "Conversations, agents and memory",
		requires: ["Connected provider; disposable workspace"],
		steps: [
			step("conversation", "Create a second conversation from More → New conversation; return to Sancho.", [
				"Conversation navigation appears with meaningful titles.",
				"No internal Side chats label or empty group section is exposed.",
			]),
			step("agent", "Create a specialist via the available creation action.", [
				"Purpose and capabilities can be reviewed.",
				"Selecting its name opens conversation; header details open configuration.",
			]),
			step(
				"memory",
				"Tell the specialist a synthetic preference, inspect its memory, correct it and delete it.",
				["Memory scope and source are understandable.", "Deletion explains that original conversation text remains."],
				"For this test, remember that I prefer vegetarian recipes and dislike coriander. Ask before changing any always-used personal instructions.",
			),
			step(
				"group",
				"If supported, create a group and address its participants; otherwise record blocked with the missing capability.",
				[
					"Membership and history visibility are explained.",
					"The composer explains that an unaddressed message starts no agent work.",
				],
			),
			step("lifecycle", "Pause the specialist and inspect historical conversations.", [
				"Active work and routine consequences are explained.",
				"Conversation history remains reachable.",
			]),
		],
	},
	{
		id: "browser",
		title: "Browser takeover and connections",
		requires: ["Working disposable box/browser; disposable test account and service"],
		steps: [
			step("browse", "Ask Sancho to open your controlled test site (send this request manually with its real URL).", [
				"Browser appears inline and expands on request.",
				"Current controller and Stop are visible.",
			]),
			step("signin", "Take over, sign in to the disposable account, and give back control.", [
				"Ownership changes are unambiguous.",
				"Agent cannot act while the owner controls the browser; sensitive values stay hidden.",
			]),
			step("send", "Exercise a supported test send, approving through the UI.", [
				"The exact send waits for approval.",
				"Stopping or declining has an understandable result.",
			]),
			step("disconnect", "Sign out through Settings → Connections, then attempt continued work.", [
				"Signed-in services and sign-out are findable.",
				"Affected work shows a useful recovery action.",
			]),
		],
	},
	{
		id: "holiday",
		title: "Family holiday end-to-end",
		requires: ["Connected provider and box; disposable calendar/send service; no real bookings"],
		steps: [
			step(
				"plan",
				"Start planning a holiday.",
				["Useful work begins without forcing project creation.", "Any needed clarification is actionable."],
				"Plan a three-day family holiday for two adults and a seven-year-old, starting from Madrid, with a total budget of €600. Prefer trains and vegetarian food. Do not book, purchase or contact anyone. Produce a reusable itinerary.",
			),
			step(
				"correct",
				"Correct the budget during work.",
				["Work reflects the correction, including its final artifact."],
				"Our total budget is now €400. Keep one relaxed afternoon with no scheduled activities.",
			),
			step("calendar", "Connect a disposable calendar through the app and review a proposed test event.", [
				"Access, exact event and approval are understandable.",
				"Declining leaves the service unchanged.",
			]),
			step("keep", "Edit the itinerary, inspect sources, then request a reviewable reminder.", [
				"Owner edits survive; source inspection preserves conversation context.",
				"Routine appears in Home's work view after acceptance.",
			]),
			step(
				"recover",
				"Interrupt the test daemon or provider while work is active; restart/reconnect and return later.",
				[
					"Failure and recovery are visible without raw details.",
					"Library, pending decisions and ongoing responsibilities remain discoverable.",
				],
			),
		],
	},
];
export function journey(id: string): Journey {
	const found = journeys.find((item) => item.id === id);
	if (!found) throw new Error("Unknown journey. Run list to see available IDs.");
	return found;
}
