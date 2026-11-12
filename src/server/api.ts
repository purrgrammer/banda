/** The shapes the HTTP API speaks, shared with the web UI (`web/`), which imports this file for its types alone. */
import type { AgentBrowserView } from "../box/browsers.ts";
import type { Agent } from "../core/agents.ts";
import type { AvatarFace } from "../core/avatar-face.ts";
import type { Attachment } from "../core/blobs.ts";
import type { Access } from "../core/connections.ts";
import type { Audience, Fact } from "../core/memory.ts";

export type { AvatarFace } from "../core/avatar-face.ts";

import type { Origin, Received } from "../core/gateway.ts";
import type { Floor, PermissionScope, Serves } from "../core/permissions.ts";
import type { OpenWait, Parked, State } from "../core/status.ts";
import type { Classed, Setting } from "../core/tool-kinds.ts";
import type { Answer, WaitEnded } from "../core/wait.ts";

export type { BrowserView, OwnerInput, ViewEvent } from "../box/browser.ts";
export type { AgentBrowserView } from "../box/browsers.ts";
export type { Agent } from "../core/agents.ts";
export type { MemoryScope, Source } from "../core/memory.ts";
export type { Floor, PermissionScope } from "../core/permissions.ts";
export type { Preview } from "../core/preview.ts";
export type { Answer, Approving, Ask, Field, Sender as Answered } from "../core/wait.ts";
// Each area's shapes live in its own file (slice 8's seams); this file only gathers them.
export type * from "./api/artifacts.ts";
export type * from "./api/band.ts";
export type * from "./api/devices.ts";
export type * from "./api/groups.ts";
export type * from "./api/harnesses.ts";
export type * from "./api/permissions.ts";
export type * from "./api/routines.ts";
export type * from "./api/tiers.ts";
export type { OpenWait, Parked, State };

import type { ArtifactsShellEvent } from "./api/artifacts.ts";
import type { BandShellEvent } from "./api/band.ts";
import type { DevicesShellEvent } from "./api/devices.ts";
import type { GroupsShellEvent } from "./api/groups.ts";
import type { HarnessesShellEvent } from "./api/harnesses.ts";
import type { RoutineRun, RoutineState } from "./api/routines.ts";

/** A tool call in an answer: what the model asked to run, with its arguments. */
export type ToolCall = {
	readonly id: string;
	readonly name: string;
	readonly args: { readonly [key: string]: unknown };
};

/**
 * What a daemon tool's call names as its subject, in its result's details, written by the daemon's code and never the
 * model's arguments: the fact `remember` wrote or `forget` took out, as its file holds it. The chat's feed finds the
 * subject by it and reads how it stands now from memory; the receipt itself never says it is done.
 */
export type Receipt =
	/** Canonical geometry validated for exactly one immutable assistant entry/call position. */
	| {
			readonly kind: "avatar";
			readonly assistant: number;
			readonly index: number;
			readonly definition: import("open-bot-avatar").AvatarDefinition;
	  }
	| { readonly kind: "fact"; readonly id: string; readonly text: string }
	| {
			readonly kind: "skill";
			readonly name: string;
			readonly sha: string;
			readonly by: "agent" | "owner";
			readonly description: string;
			readonly files: readonly string[];
			/** The owner's input this pre-request load belongs to; absent for an agent's own load. */
			readonly invocation?: { readonly gateway: string; readonly message: string };
	  }
	/** Artifacts a message showed again, each at the version current when it was sent. */
	| { readonly kind: "artifacts"; readonly artifacts: readonly { readonly id: string; readonly n: number }[] }
	/** A `schedule` call's file: the routine, its hash, and whether it made, changed or kept one. */
	| {
			readonly kind: "routine";
			readonly name: string;
			readonly sha: string;
			readonly change: "added" | "changed" | "same";
	  }
	/** A `watch` call's file: the watch, its hash, and whether it made, changed or kept one. */
	| {
			readonly kind: "watch";
			readonly name: string;
			readonly sha: string;
			readonly change: "added" | "changed" | "same";
	  };

/** A remark the harness or the tool made about a call: its exit code, what was truncated, where the full output is. */
export type ToolNote = { readonly severity: "info" | "warn" | "error"; readonly code: string; readonly text: string };

/**
 * Tokens of one model request, as the provider reported them. `input` is what was sent uncached; the context the
 * request held is `input + cacheRead + cacheWrite`. `reasoning` is part of `output`, when the provider says.
 */
export type TurnUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	/** In dollars, by the catalog's prices; 0 when it has none. */
	readonly cost: number;
};

/** How full a chat's context is, against the budget it compacts at (DESIGN.md "The prompt"). */
export type ChatContext = {
	/** The chat's model, `provider/modelId`, when one is set. */
	readonly model?: string;
	/** The model's window, in tokens. */
	readonly window?: number;
	/** The context of the newest answer since the last compaction, as its provider counted it; absent before one. */
	readonly tokens?: number;
	/** Where a compaction starts in the background, and where the next request waits for one. */
	readonly background?: number;
	readonly budget?: number;
	/** The newest compaction's item, when the model's context starts at one. */
	readonly since?: number;
	/** A compaction is being made now. */
	readonly compacting: boolean;
	/** Why the newest compaction failed, until one succeeds. */
	readonly failure?: string;
	/** Everything the chat spent, summaries and failed attempts included. */
	readonly spent: TurnUsage;
};

/** What a chat's model is sent before the conversation: its system prompt and its tools, as the raw transcript shows. */
export type ChatPrompt = {
	/** Empty before the chat's first request. */
	readonly system: string;
	readonly tools: readonly {
		readonly name: string;
		readonly description: string;
		/** The tool's arguments, as the JSON schema the model receives. */
		readonly parameters: { readonly [key: string]: unknown };
	}[];
};

/** One row of a transcript: what the owner reads, derived from one entry. */
export type Item =
	| {
			readonly id: number;
			readonly role: "user";
			readonly text: string;
			readonly at?: number;
			readonly origin?: Origin;
			/** The gateway's id for the message. */
			readonly message?: string;
			/** Images that came with it, fetched one by one (`/api/chats/:id/items/:item/images/:n`). */
			readonly images?: number;
			/** Files that came with it, by their blobs (`/api/blobs/:sha`). */
			readonly files?: readonly Attachment[];
			/** The owner's version of an artifact it tells of: the app shows its card. */
			readonly artifact?: { readonly id: string; readonly n: number };
	  }
	| {
			readonly id: number;
			readonly role: "assistant";
			/** The recorded model boundary: a tool round continues; a final answer ends it. */
			readonly stop?: import("@earendil-works/pi-ai").StopReason;
			readonly text: string;
			/** What the model thought before answering, when it shows its thinking. */
			readonly thinking?: string;
			readonly at?: number;
			/** How long it thought, when the daemon timed it. */
			readonly thinkingMs?: number;
			/** Why the answer ended early: the provider's error, or `interrupted`; any text before it stands. */
			readonly error?: string;
			/** The tools it called, in order; each result is a `tool` item of its own. */
			readonly calls?: readonly ToolCall[];
			/** The model that answered, `provider/modelId`. */
			readonly model?: string;
			/** What the request and its answer took, as the provider reported it. */
			readonly usage?: TurnUsage;
	  }
	/**
	 * A compaction: from here the model sees `summary` in place of the entries before it, which stay in the store. The
	 * raw transcript shows it; the chat does not.
	 */
	| {
			readonly id: number;
			readonly role: "compaction";
			/** `threshold` (the budget), `overflow` (the provider refused the size) or `manual`. */
			readonly reason: string;
			readonly summary: string;
			readonly at?: number;
	  }
	/** A tool call's result. */
	| {
			readonly id: number;
			readonly role: "tool";
			/** The call's id, as in its answer's `calls`. */
			readonly call: string;
			readonly name: string;
			/** What the model was given back, as text. */
			readonly text: string;
			readonly error: boolean;
			readonly at?: number;
			readonly durationMs?: number;
			readonly notes?: readonly ToolNote[];
			/** An edit's change, as a unified diff. */
			readonly patch?: string;
			/** Images in the result (a read of an image). */
			readonly images?: number;
			/** What a daemon tool says it committed, for the chat's feed (`Receipt`). */
			readonly receipt?: Receipt;
	  }
	/** A recorded daemon instruction to the model, not a message from the owner. */
	| { readonly id: number; readonly role: "instruction"; readonly text: string; readonly at?: number }
	/**
	 * A notice in the daemon's words; one about a routine in trouble, or a watch unable to look for an hour, names it, so
	 * the chat draws it in its own words.
	 */
	| {
			readonly id: number;
			readonly role: "notice";
			readonly text: string;
			readonly routine?: import("../core/routines.ts").TroubleData;
			readonly watch?: import("../core/watches.ts").WatchTroubleData;
			readonly at?: number;
	  }
	/** An effect ran without asking, within a permission the owner gave: what ran, in the daemon's words, and the permission. */
	| {
			readonly id: number;
			readonly role: "effect";
			readonly label: string;
			readonly permission: { readonly what: string; readonly scope: PermissionScope["scope"]; readonly until?: number };
			readonly at: number;
	  }
	/** An owner-reviewed proposal made by an agent; pending changes have no effect until accepted. */
	| {
			readonly id: number;
			readonly role: "proposal";
			readonly proposal: import("./proposals.ts").ProposalView;
	  }
	/** The owner accepted or kept a proposal as it was. */
	| {
			readonly id: number;
			readonly role: "proposalResult";
			readonly proposal: string;
			readonly state: "accepted" | "declined";
	  }
	/** A message another agent sent here; the recipient's turn decides what to do with it. */
	| {
			readonly id: number;
			readonly role: "agentMessage";
			readonly from: string;
			readonly text: string;
			readonly at?: number;
	  }
	/** A routine woke its agent: which, what it is for, and whether the owner ran it now. */
	| {
			readonly id: number;
			readonly role: "wake";
			readonly routine: string;
			readonly text: string;
			readonly owner?: true;
			readonly at?: number;
	  }
	/**
	 * A followed object changed: the watch, the object (its key names its card) and the changes in the kind's words;
	 * `tell` when the changes only told the chat and woke no run; `ended` with what ended the watch on its last wake.
	 */
	| {
			readonly id: number;
			readonly role: "watch";
			readonly watch: string;
			readonly object: import("../core/watches.ts").WatchWakeData["object"];
			readonly changes: readonly string[];
			/** The object and the changes in one line: "acme/banda #142: ana approved". */
			readonly text: string;
			readonly tell?: true;
			readonly ended?: string;
			/** What changed while it was paused, come together at the look after resuming. */
			readonly resumed?: true;
			/** Some changes may be missing: its cursor fell off the readings kept. */
			readonly gap?: true;
			/** When the first of the changes that came together was seen: held while a run went, or until they settled. */
			readonly burst?: number;
			readonly at: number;
	  }
	/** An ask that ended: what was asked, and how it ended; an approval with what it would run, in words. */
	| ({ readonly id: number; readonly role: "wait"; readonly label?: string } & WaitEnded);

/**
 * `GET /api/search?q=`: the best matches, best first: a message in an agent's chat or in a group, each at its entry
 * (the chat opens there), or an artifact by its title and words. Text is a bounded matching excerpt; open the source
 * for its full context.
 */
export type SearchHit =
	| {
			readonly kind: "chat";
			readonly chat: number;
			readonly agent: string;
			readonly entry: number;
			readonly by: "owner" | "agent";
			readonly text: string;
			readonly at: number;
	  }
	| {
			readonly kind: "group";
			readonly room: number;
			readonly entry: number;
			/** "owner", or the member who said it. */
			readonly who: string;
			readonly text: string;
			readonly at: number;
	  }
	| { readonly kind: "artifact"; readonly id: string; readonly title: string; readonly text: string };

export type ChatRow = {
	readonly chat: number;
	readonly origin: Origin;
	/** The agent it runs. */
	readonly agent: string;
	/** The first message, as the chat's name. */
	readonly title: string;
	/** When it last heard or said something (epoch ms), for the list's relative time; absent before anything was said. */
	readonly at?: number;
	readonly state: State;
	readonly unanswered: number;
	/** Visible agent replies after the owner's last opening of this chat. */
	readonly unread: number;
	/** The newest entry the owner read: the unread divider sits after it. */
	readonly read: number;
	/** The newest thing said, one plain line, and who said it: the row's excerpt ("You: …" when the owner did). */
	readonly excerpt?: string;
	readonly by?: "owner" | "agent";
	/** When the newest thing that reached the owner came (epoch ms): the band orders and times its rows by it. */
	readonly said?: number;
	/** An ask open in it, in a few words: the row reads "Waiting: …". */
	readonly ask?: string;
	/**
	 * How hard it thinks: the tier it runs on (the owner switches it with `POST /api/chats/:id/tier`, from its next run
	 * on); `custom` when its agent file names a model of its own, which no tier changes. Absent for a chat started
	 * before tiers.
	 */
	readonly tier?: import("../core/tiers.ts").Tier;
	readonly custom?: true;
};

/**
 * The companion's computer (the box): up, coming up, built (the first run), or offline (it then runs nothing, and never
 * falls back to an open network) and why; and whether its network is closed but for the egress proxy.
 */
export type ComputerView = {
	readonly state: "starting" | "building" | "up" | "offline";
	/** Offline: why, in plain words where it is the owner's to fix (Docker missing, stopped, too old). */
	readonly why?: string;
	/** `host`: no box, its commands run on the daemon's own machine, unguarded (host mode, asked for by name). */
	readonly box: "container" | "host";
	readonly network: "guarded" | "none";
};

/** A model provider in plain words ("Anthropic"), and whether it runs on this computer, so nothing leaves it. */
export type SeenBy = { readonly name: string; readonly local: boolean };

/** A page of a transcript, oldest first; `next` continues the scan in the same direction. */
export type ItemPage = { readonly items: readonly Item[]; readonly next?: number };

/** A tool call running now, with its output so far (the tail the harness keeps). */
export type RunningTool = {
	readonly call: string;
	readonly name: string;
	readonly output: string;
	/** Whether output before `output` was dropped. */
	readonly dropped?: boolean;
	/** What it is doing, as one plain line; absent for a message, which shows itself. */
	readonly doing?: string;
};

/** One content block of the answer being generated, including a tool call's partial arguments. */
export type Block = {
	readonly type: "text" | "thinking" | "tool" | "other";
	readonly text: string;
	readonly call?: ToolCall;
	/** A thinking block's start and end (epoch ms), so a live view counts from the start and stops at the end. */
	readonly startedAt?: number;
	readonly endedAt?: number;
};

/**
 * A chat's live events (`GET /api/chats/:id/events`, server-sent). `ready` comes first and again
 * whenever the stream lost events: entries after `tail` are fetched by id, so none is missed or shown twice.
 */
export type LiveEvent =
	| {
			readonly type: "ready";
			readonly tail: number;
			readonly busy: boolean;
			/** The entry of this run's first input, stable across steering and generation turns. */
			readonly input?: number;
			readonly partial: readonly Block[];
			readonly running: readonly RunningTool[];
	  }
	| { readonly type: "entry"; readonly item: Item }
	/** The answer being generated, by block: `start` replaces it, `delta` appends to one block. */
	| { readonly type: "start"; readonly partial: readonly Block[] }
	| { readonly type: "delta"; readonly index: number; readonly text: string }
	| { readonly type: "busy"; readonly busy: boolean; readonly input?: number }
	/** A tool call started, its output grew (`trim` characters dropped from the front, then `append`), or it ended. */
	| {
			readonly type: "tool";
			readonly call: string;
			readonly name: string;
			/** What it is doing, as one plain line; absent for a message, which shows itself. */
			readonly doing?: string;
	  }
	| {
			readonly type: "output";
			readonly call: string;
			readonly trim?: number;
			readonly append?: string;
			readonly set?: string;
	  }
	| { readonly type: "toolEnd"; readonly call: string }
	/** The chat's open asks, whole, first after `ready` and whenever they change. */
	| { readonly type: "waits"; readonly waits: readonly ShownWait[] }
	/** The owner's messages waiting in the queue for the run at work, whole, first after `ready` and whenever it changes. */
	| { readonly type: "queued"; readonly queued: readonly Queued[] };

/**
 * An owner's message in the chat's queue (pi-durable's inbox): sent while a run works, not yet in the transcript. It
 * leaves the queue when the run takes it (an entry with the same `message` follows) or a stop withdraws it.
 */
export type Queued = {
	/** Its submission's id. */
	readonly id: string;
	readonly text: string;
	/** The gateway's id for the message, as its entry will carry it. */
	readonly message?: string;
	/** Files that came with it, by their blobs. */
	readonly files?: readonly Attachment[];
	/** Images pasted without a file. */
	readonly images?: number;
};

/** An open ask as the app shows it: an approval with what it would run, in words ("Allow running a command?"). */
export type ShownWait = OpenWait & { readonly label?: string };

/** `POST /api/messages`: a web message; `id` is the browser's, so a retried post starts nothing new. */
/** `POST /api/messages`: to a new thread (starting a chat), or to a chat by its id. */
/** A file already uploaded (`POST /api/blobs`), by its blob, and the name it goes by. */
export type PostedFile = { readonly sha: string; readonly name: string };

export type PostMessage = {
	readonly id: string;
	readonly text: string;
	readonly files?: readonly PostedFile[];
} /** A new thread runs `agent`, else the lead. */ & (
	| { readonly thread: string; readonly agent?: string }
	| { readonly chat: number }
);

/** An agent file's text as the store or the box holds it, and what it says, or why it says nothing. */
export type AgentFileView = {
	readonly sha: string;
	readonly text: string;
	/** When the store accepted it (the accepted version only): an archived agent's, when it was archived. */
	readonly at?: number;
	readonly agent?: Agent;
	readonly errors?: readonly string[];
};

/**
 * An agent (`GET /api/agents`): the version in effect, accepted, and the change the box holds, which takes effect once
 * the owner accepts it (`POST /api/agents/:name/accept` with the `sha` shown, or null for a removal).
 */
export type AgentView = {
	readonly name: string;
	readonly accepted?: AgentFileView;
	readonly change?: ({ readonly kind: "added" | "changed" } & Partial<AgentFileView>) | { readonly kind: "removed" };
};

/** It started a Turn, answered the chat's open question, or was refused (an answer, or a chat not the owner's). */
export type Posted = Received;

/** `POST /api/waits/:key`: answer the open ask with this id, as the owner. */
export type AnswerWait = {
	readonly answer: Answer;
	readonly via?: "web" | "cli";
	/** The kind of ask this answers; another kind is refused. */
	readonly type?: "question" | "approval";
	/** An approval's draft text as the owner edited it, by argument: what runs instead. */
	readonly edits?: { readonly [arg: string]: string };
	/** A permission given with an approval: later effects of the same shape run without asking while it is open. */
	readonly permission?: PermissionScope;
};

/**
 * The first agent's picks (`GET /api/companion`): its name (Sancho until changed) and face, the defaults until picked;
 * its personality, the words of the lead's file's section (none when it has none); the tier new chats start on; and
 * since when everything is paused, while it is. `PUT /api/companion` changes any of `name`, `face`, `personality` and
 * `tier`. The models the tiers run on are `TiersView`'s (`GET /api/tiers`).
 */
export type CompanionView = {
	/** The tier new chats start on; the daemon always says, and a view without one reads as Quick. */
	readonly tier?: import("../core/tiers.ts").Tier;
	readonly name?: string;
	readonly face: AvatarFace;
	/** How it speaks, in the owner's words. */
	readonly personality?: string;
	/** Since when everything is paused, while it is. */
	readonly paused?: number;
};

/** `GET /api/events` (server-sent): the chat list, the agents and the companion, whole, whenever one changes. */
export type ShellEvent =
	/** The live events of the chat the page shows (`GET /api/events?chat=`); `gone` when there is no such chat. */
	| { readonly type: "live"; readonly chat: number; readonly event: LiveEvent | { readonly type: "gone" } }
	| { readonly type: "chats"; readonly rows: readonly ChatRow[] }
	| { readonly type: "agents"; readonly agents: readonly AgentView[] }
	| { readonly type: "companion"; readonly companion: CompanionView }
	| { readonly type: "control"; readonly control: ControlView }
	| { readonly type: "memory"; readonly memory: MemoryView }
	| { readonly type: "computer"; readonly computer: ComputerView }
	| { readonly type: "capabilities"; readonly capabilities: CapabilitiesView }
	| { readonly type: "browsers"; readonly browsers: readonly AgentBrowserView[] }
	| WatchesShellEvent
	| ArtifactsShellEvent
	| BandShellEvent
	| DevicesShellEvent
	| GroupsShellEvent
	| HarnessesShellEvent;

/**
 * A saved fact and its audience; no workspace path on consumer screens. `from` is the owner's metadata alone:
 * the prompt section never carries it, so an agent cannot read who wrote a fact. `size` is the characters the
 * fact takes of its scope's budget, as the daemon counts them.
 */
export type FactView = Omit<Fact, "path"> & Audience & { readonly size?: number };

/** The owner's view of all scopes. An unavailable box is not empty memory. */
export type MemoryView = {
	readonly facts: readonly FactView[];
	/** Each scope's budget, in the characters `size` counts. */
	readonly budget?: number;
	readonly unavailable?: true;
};

/** A routine's file as the owner reads it: what it is for, when it runs, and what it does, in plain words. */
export type RoutineSummary = {
	readonly description: string;
	/** When it runs, in words ("Every day at 09:00"); a one-time routine says "Once", with its time in `at`. */
	readonly when: string;
	readonly at?: number;
	/** When it runs as one line (`cron 0 8 * * 1-5`): what the schedule picker starts from. */
	readonly schedule: string;
	/** The IANA time zone its wall times (`at`, `cron`) are in: its file's, or the daemon's computer's. */
	readonly zone?: string;

	/** The most times it may run in one day before it pauses itself. */
	readonly runsADay: number;
	/** What it asks its agent to do, each run. */
	readonly ask: string;
};

/** A routine file's text as the store or the box holds it, and what it says, or why it says nothing. */
export type RoutineFileView = {
	readonly sha: string;
	readonly routine?: RoutineSummary;
	readonly errors?: readonly string[];
};

/**
 * A routine: the version in effect, the change the box holds (allowed with `POST
 * /api/routines/:name/accept` and the `sha` shown, or null for a removal), and its state from the store.
 */
export type RoutineView = {
	readonly name: string;
	readonly accepted?: RoutineFileView;
	readonly change?: ({ readonly kind: "added" | "changed" } & Partial<RoutineFileView>) | { readonly kind: "removed" };
	/** How it stands. */
	readonly state: RoutineState;
	/** When it next runs, while it is scheduled. */
	readonly next?: number;
	/** Its next runs (up to 3), while it is scheduled, the first being `next`. */
	readonly nextRuns?: readonly number[];
	/** Its runs in the next seven days (at most 48), for the timeline. */
	readonly week?: readonly number[];
	/** Its newest run, and what came of it. */
	readonly last?: RoutineRun;
	readonly paused?: "owner" | "limit";
	/** A one-time routine that ran, when. */
	readonly done?: number;
	/** When it last woke the companion. */
	readonly lastRun?: number;
	/** Whether that run still goes. */
	readonly running?: boolean;
	/** The agent it belongs to, by id: its runs happen in that agent's chat. */
	readonly agent: string;
	/** The hashes of the box's versions the owner allowed, newest last: a chat that wrote one of them says so. */
	readonly allowed?: readonly string[];
};

/** One thing a routine, an effect within a permission, or the owner in the control room, did; where, to open it. */
export type ActivityView = {
	readonly at: number;
	readonly routine?: string;
	readonly watch?: string;
	readonly what: string;
	readonly chat?: number;
	/** It reached outside the companion's computer: something read, or a request sent for the owner. */
	readonly outside?: "read" | "sent";
};

/**
 * A permission the owner gave and has not taken back, open now: what it lets run without asking, in the daemon's words
 * ("send an email to ana@example.com"), and for how long. `POST /api/permissions/:id/revoke` takes it back at once.
 */
export type PermissionView = {
	readonly id: string;
	readonly what: string;
	readonly scope: PermissionScope["scope"];
	readonly until?: number;
	readonly at: number;
	/** For a task: the chat it is for. */
	readonly chat?: number;
	/** The agent of the chat it was given in: its Access tab lists it. */
	readonly agent?: string;
	/** For a host's: the host it allows, as the proxy spells it (`*.example.com`, `*` for every host). */
	readonly host?: string;
	/** What it serves: the task it was given in, or the routine whose run asked; Permissions groups by it. */
	readonly serves?: Serves;
};

/** A watch's file as the owner reads it: what it follows, with which account, what ends it, and what matters. */
export type WatchSummary = {
	/** The object, as the file names it: a link, or an id. */
	readonly object: string;
	readonly account?: string;
	readonly until?: string;
	/** The most times it may wake in a day before it pauses itself. */
	readonly wakesADay?: number;
	readonly ask: string;
};

/** A watch file's text as the store or the box holds it, and what it says, or why it says nothing. */
export type WatchFileView = {
	readonly sha: string;
	readonly watch?: WatchSummary;
	readonly errors?: readonly string[];
};

/**
 * How a watch stands, in one word: waiting for the owner to allow a change the box made, looking, paused by the
 * owner, unable to look (its row says why), or done (what ended it).
 */
export type WatchState = "allow" | "active" | "paused" | "failing" | "done";

/**
 * A watch (DESIGN.md "Watches"): the version in effect, the change the box holds (allowed with `POST
 * /api/watches/:name/accept` and the `sha` shown, or null for a removal), what it follows as the store resolved it,
 * and how it stands. `POST /api/watches/:name/check` looks now; `/pause`, `/resume` and `/remove` as routines.
 */
export type WatchView = {
	readonly name: string;
	readonly accepted?: WatchFileView;
	readonly change?: ({ readonly kind: "added" | "changed" } & Partial<WatchFileView>) | { readonly kind: "removed" };
	readonly state: WatchState;
	/** The agent it belongs to, by id: its wakes happen in that agent's chat. */
	readonly agent: string;
	/** The object it follows, once the daemon resolved it: its reading's key, the reference its card is read by, its name, where and as whom. */
	readonly object?: {
		readonly key: string;
		readonly ref: string;
		readonly name: string;
		readonly connection: string;
		readonly service: string;
		readonly account?: string;
		/** The words that can end it, as its kind says: what `until` may be. */
		readonly ends?: readonly string[];
		/**
		 * The version of the reading kept of it, which its card draws: it moves when the object changed, not when it was
		 * only looked at, so a card read at one version is current until the next.
		 */
		readonly version?: number;
	};
	/** When it last looked, and when it looks next. */
	readonly looked?: number;
	readonly next?: number;
	/** The newest changes it saw, in the kind's words, and when. */
	readonly saw?: readonly string[];
	readonly sawAt?: number;
	/**
	 * Why it cannot look, in the daemon's words: at its newest try, and since the first of this run of them; `run` when
	 * it was its wake's run that failed.
	 */
	readonly failed?: {
		readonly at: number;
		readonly why: string;
		readonly since: number;
		readonly run?: true;
		/** The owner's switch holds a read off: stopped, with no line in its chat, and `why` says what to change. */
		readonly off?: true;
	};
	/** When it last woke its agent. */
	readonly lastRun?: number;
	/** Behind since then: its newest wake said some changes may be missing, until a later one without a gap. */
	readonly behind?: number;
	/** Reading behind since then: more came than a page holds, and it walks the service's pages to what it kept, one a look. */
	readonly pages?: { readonly since: number };
	/** Paused alone: by the owner, or by waking the most times a day it may (`limit`). */
	readonly paused?: "owner" | "limit";
	/** Done: when, and what ended it; `authority` when it was its account or connection taken away. */
	readonly done?: { readonly at: number; readonly why: string; readonly authority?: true };
	/** The hashes of the box's versions the owner allowed, newest last: a chat that wrote one of them says so. */
	readonly allowed?: readonly string[];
};

/**
 * The watches, as the watches area pushes them on the shell stream: written when they changed (a look, a change seen,
 * an end, a pause), never with the rest of the shell.
 */
export type WatchesShellEvent = { readonly type: "watches"; readonly watches: readonly WatchView[] };

/**
 * The control room (`GET /api/control`), from the store alone: whether everything is paused (since when), the routines,
 * the tasks in progress (working, waiting on the owner, or paused), newest first, and the activity, newest first.
 * `POST /api/control/pause` and `/resume` flip it.
 */
export type ControlView = {
	readonly paused?: number;
	readonly routines: readonly RoutineView[];
	readonly activity: readonly ActivityView[];
	/** The permissions open now, oldest first. */
	readonly permissions: readonly PermissionView[];
	/**
	 * The "before" files the owner took out of effect after accepting them, by workspace path: when. A chat that made
	 * one says it was removed since, not that it never took effect.
	 */
	readonly removed?: { readonly [path: string]: number };
};

/**
 * A connection as the owner reads it (DESIGN.md "Connections"): the service in their words, where it is (a host, or
 * the companion's own computer for a server it built), how banda signs in, what it says only reads, what is on the
 * floor, and why the companion wants it; for a server in its computer, the command it runs.
 */
export type ConnectionSummary = {
	readonly service: string;
	readonly url: string;
	readonly where: string;
	readonly auth: "none" | "key" | "oauth";
	readonly reads: readonly string[];
	readonly floors: { readonly [tool: string]: Floor };
	/** The scopes a new account asks for unless the owner chooses others, when the file names them. */
	readonly scopes?: readonly string[];
	/**
	 * What an account may ask for: `scopes` and every scope a tool needs (`POST …/signin` with `scopes` picks from it).
	 * Absent when the file names no scopes: its sign-in asks for what the server offers, with no choice.
	 */
	readonly ceiling?: readonly string[];
	/** The scope every account asks for (a built-in API's base): always among a sign-in's `scopes`. */
	readonly required?: readonly string[];
	/** How many of its tools need each scope, as its file says: what the owner weighs picking one. */
	readonly needs?: { readonly [scope: string]: number };
};

/**
 * A connection's tool, as listed when it was connected: the name the model knows it by, the server's own, in words,
 * the server's description; a read (runs when called) or a write (asks first; on the floor, every time); and whether
 * it is on (`POST …/connections/:name/tools`).
 */
export type ConnectionToolView = {
	readonly name: string;
	readonly parameters?: Readonly<Record<string, unknown>>;
	readonly alwaysAsk?: true;
	readonly title: string;
	readonly words: string;
	readonly description: string;
	readonly kind: "read" | "write";
	readonly floor?: Floor;
	readonly on: boolean;
	/** For a tool that only reads for some arguments: when, in words ("uri is _ernesto://resolve"). */
	readonly readsWhen?: readonly string[];
	/** Scopes it needs that the sign-in was not given, as the server said when it was called. */
	readonly needs?: readonly string[];
	/** What the server says of it (`readOnlyHint`): only reads, or changes something; absent when it said nothing. */
	readonly hint?: "reads" | "changes";
	/**
	 * What it does and who said so: its definition, the owner, the server's annotations, or nobody. A server's "reads" is
	 * only proposed until the owner allows it.
	 */
	readonly classed?: Classed;
	/** Its group: as the definition says, else by its name. */
	readonly group?: string;
	/** What the owner set it to now, of `options`: absent where it has no settings (`POST …/connections/:name/tools`). */
	readonly setting?: Setting;
	/** What it may be set to; none widens what a known write or floor does. */
	readonly options?: readonly Setting[];
	/** Switched off because the server listed it alone and no definition names it: waiting for the owner, not their off. */
	readonly waiting?: true;
	/** A kind this connection draws reads it: Off also stops those cards and the watches that follow them. */
	readonly cards?: true;
};

/** A kind a connection draws as cards, and what following one does, in words. Absent `follow`: it cannot be followed. */
export type KindView = {
	readonly kind: string;
	readonly label: string;
	readonly follow?: { readonly wakes: readonly string[]; readonly tells: readonly string[] };
};

/**
 * A connection (`GET /api/capabilities`): the version in effect and how it stands: waiting for the owner to sign in
 * (`POST …/signin` gives the page) or give a key (`POST …/key`), connecting, connected, or not reached (`problem`, in
 * words).
 */
export type ConnectionView = {
	readonly name: string;
	/** Explicit anonymous access; no account is created for a public server. */
	readonly agents?: readonly string[];
	readonly accepted?: {
		readonly version: string;
		readonly connection?: ConnectionSummary;
	};
	readonly state: "waiting" | "sign-in" | "signing-in" | "key" | "connecting" | "connected" | "problem";
	/** When it last changed (allowed, or its tools listed again), epoch ms: the newest come first. */
	readonly at?: number;
	/** The server's own notes about its tools, as kept when it was connected: what the model is told of them. */
	readonly notes?: string;
	/** The scopes the server says it can grant, once known: what the owner picks from. */
	readonly offered?: readonly string[];
	/**
	 * While signing in by code: what the owner types, the server's page to type it at, when it stops working, and the
	 * agent it was started for.
	 */
	readonly code?: { readonly code: string; readonly page: string; readonly expires: number; readonly agent?: string };
	/**
	 * Its accounts, for a connection signed in to (`POST …/signin` with `agent` signs one in and switches it on for that
	 * agent, with `scopes` asks for those instead of the file's default, and with `account` signs that account in
	 * again; `POST …/accounts/:account/switch` with `agent` and `on`; `POST …/accounts/:account/signout`).
	 */
	readonly accounts?: readonly AccountView[];
	/** The last sign-in that finished: whom as, for which agent, and whether that account was known already. */
	readonly finished?: {
		readonly account: string;
		readonly id: string;
		readonly agent?: string;
		readonly enabled?: boolean;
		readonly problem?: string;
		readonly known: boolean;
		/** The account the owner was signing in again, when the sign-in came back as `account` instead. */
		readonly expected?: string;
		readonly at: number;
	};
	readonly problem?: string;
	readonly tools: readonly ConnectionToolView[];
	/** Its tools' groups, in the order they are shown. */
	readonly groups: readonly string[];
	/** The kinds it draws as cards. */
	readonly draws: readonly KindView[];
};

/**
 * An account of a connection: one sign-in, named by what the service calls the owner ("@bandarra"), the agents that may
 * use it, and whether its credentials no longer fit the connection's definition (it signs in again).
 */
export type AccountView = {
	/** Its key in the API's paths. */
	readonly account: string;
	readonly id: string;
	readonly label: string;
	/** The server did not say whom this sign-in is for: its `label` is the owner's to change. */
	readonly numbered?: boolean;
	readonly at: number;
	readonly agents: readonly string[];
	readonly stale?: boolean;
	/** The scopes this account was given (as the service said, else as it asked): its own, whatever the others'. */
	readonly scopes?: readonly string[];
	/** Scopes it may ask for that a tool needs and it was not given, one per tool: "needs Send email". */
	readonly missing?: readonly string[];
};

/** What the companion can use beyond its computer: its connections, and the tools it made. */
/**
 * A connection banda ships, as this banda ships it: what it reaches and does, the line the app says under its name,
 * the access the owner chooses among before signing in, and whether it is added in this home (`POST …/add`).
 */
export type ShippedView = {
	readonly name: string;
	readonly connection: ConnectionSummary;
	/** What it lets the band do, in a line. */
	readonly about: string;
	readonly access?: Access;
	/** How many of its tools only read. */
	readonly reads: number;
	readonly added: boolean;
};

export type CapabilitiesView = {
	readonly connections: readonly ConnectionView[];
	/** The connections banda ships, to add with one tap. */
	readonly shipped?: readonly ShippedView[];
	/** Sites the owner signed in to in an agent's browser: sessions it keeps, until they sign it out; each with its agent. */
	readonly signedIn?: readonly { readonly agent: string; readonly site: string; readonly at: number }[];
};

/** A file and what the daemon drew of it from its bytes: its preview, its size and its media type. */
export type FilePreview = {
	readonly sha: string;
	readonly name: string;
	readonly mimeType: string;
	readonly size: number;
	readonly preview: import("../core/preview.ts").Preview;
};
