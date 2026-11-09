/**
 * Fault injection at the effect boundaries: storage commits (before the write, and after it is stored), gateway sends
 * (before the bytes go out, and after), model requests, answers to Waits, effects in the middle of running, commands
 * in the box (before they start, and while they run), memory files written (before and after), search catching up, a permission revoked,
 * tickets taken from the egress proxy and held requests sent, artifacts stored and written back. A schedule names a point, the hit on which it fires, and
 * what happens: `kill` ends the process with SIGKILL, as a power cut or the OOM killer would; `error` throws there,
 * as a failing disk, network or provider does. A storage error fails the Harness, which closes itself.
 */
import type { Storage } from "@earendil-works/pi-durable";

export type FaultPoint =
	| import("../../src/server/remote.ts").KeyPoint
	| "commit:before"
	| "commit:after"
	| "send:before"
	| "send:after"
	| "model"
	/** A synthetic accepted skill round admitted before the owner's input. */
	| "skill:write:before"
	| "skill:write:after"
	/** Before someone answers an open Wait. */
	| "answer"
	/** Before the owner revokes a permission. */
	| "revoke"
	/** Inside an effect, after it started and before it returns. */
	| "effect"
	/** A command in the box: before it starts, and when its first output arrives. */
	| "exec:before"
	| "exec:output"
	/** The owner's change of when a routine runs, written into the box: before its bytes go, and once they are there. */
	| "when:before"
	| "when:after"
	/** A watch's look: its reads made, before the commit that keeps the reading and the wake. */
	| "watch:read"
	/** A memory file written into the box: before its bytes go, and once they are there. */
	| "memory:before"
	| "memory:after"
	/** Search catching up, inside its transaction, before it commits. */
	| "index"
	/** Tickets taken from the egress proxy: before the store holds them, and before the proxy forgets them. */
	| "intake"
	| "intake:stored"
	/** Writes the proxy sent straight through under a host permission, taken: before the store logs them. */
	| "intake:sent"
	/** A held request sent: before the proxy sends it, and once it answered, before the store records it. */
	| "replay"
	| "replay:sent"
	/** A held request's release: before its effect, once it ended and before that is stored; then before the agent is woken with it. */
	| "release:run"
	| "release:ran"
	| "release:told"
	/** A chat with no home told outside the commit that ends its release: once submitted, before that end. */
	| "release:submitted"
	/** A connection allowed: before the store holds it, and after. */
	| "accept:before"
	| "accept:after"
	/** Signing in: the sign-in taken at the callback, the code traded for tokens, the tokens kept. */
	| "oauth:taken"
	| "oauth:exchanged"
	| "oauth:kept"
	| "oauth:device"
	/** A connection banda ships: before the store has it on, once it does; before it is removed, once it was. */
	| "shipped:before"
	| "shipped:added"
	| "shipped:remove"
	| "shipped:removed"
	/** Bringing from the other harnesses: the skills written, then accepted, then each agent saved. */
	| "bring:written"
	| "bring:accepted"
	| "bring:agent"
	| "server:before"
	| "server:added"
	| "server:remove"
	| "server:removed"
	/** A connection's tools listed, before the store holds them. */
	| "connect:listed"
	/** An account: whom a sign-in is for read; added to the store; its agent's file rewritten; switched; signed out. */
	| "account:read"
	| "account:added"
	| "account:file"
	| "account:switched"
	| "account:signed-out"
	| "account:named"
	/** OAuth refresh networking and generation/version CAS of the private credential. */
	| "credential:refresh"
	| "credential:refreshed"
	| "credential:replace"
	| "credential:replaced"
	/** A call to a remote server: before it goes, and once it answered, before the store records it. */
	| "connection:call"
	| "connection:answered"
	/** An object read for its card: before the read goes, and once its reading is in the store. */
	| "object:read"
	| "object:answered"
	| "object:kept"
	/** A Gmail attachment: read, bytes received, blob put, and object/blob hold committed. */
	| "object:attachment:read"
	| "object:attachment:received"
	| "object:attachment:stored"
	| "object:attachment:kept"
	/** A web_fetch read: before its request goes, and once it answered, before the read is taken into the store. */
	| "fetch"
	| "fetch:answered"
	/**
	 * The browser: its start, each action, a page's write sent through the proxy, a key kept and once it is; a call
	 * about to wait for the owner to give it back, and the owner giving it back.
	 */
	| "browser:start"
	| "browser:action"
	| "browser:send"
	/** A sign-in handed over, kept, before the browser is given back. */
	| "browser:signed-in"
	| "browser:capture"
	| "browser:captured"
	| "browser:wait"
	| "browser:give-back"
	/** A task paused: once its mark is stored, before what its chat runs is stopped. */
	| "task:pause"
	/**
	 * An artifact's bytes stored as a blob, before they go; its owner's version written into the box: before the box's
	 * file is moved aside, once it was, and once the owner's version is in its place.
	 */
	| "artifact:blob"
	| "artifact:write"
	| "artifact:aside"
	| "artifact:written"
	/**
	 * A proposal accepted: what it writes into the box is there, before the commit that puts it in effect.
	 */
	| "proposal:apply"
	/** A new agent the lead proposes, before its before-file is written into the box. */
	| "agent:propose"
	/** Owner agent-file publication, before and after its filesystem write. */
	| "agent:write:before"
	| "agent:write:after"
	/**
	 * A box script cut short: it runs only its first `hit` lines and then the process is killed, as a daemon killed
	 * while the script ran leaves it. Fired by the worker that runs the script, never by `hit()`.
	 */
	| "exec:cut"
	/** A harness session: its harness spawned, its ask sent, an update of its work, its ask of the owner. */
	| "harness:spawn"
	| "harness:prompted"
	| "harness:update"
	| "harness:ask"
	| "harness:note";
export type Fault = { readonly point: FaultPoint; readonly hit: number; readonly kind: "kill" | "error" };

export class InjectedFault extends Error {
	override name = "InjectedFault";
}

export class Faults {
	readonly #schedule: readonly Fault[];
	readonly #hits = new Map<FaultPoint, number>();

	constructor(schedule: readonly Fault[] = []) {
		this.#schedule = schedule;
	}

	/** Count a hit of `point` and fire what the schedule says for it. */
	hit(point: FaultPoint): void {
		const hits = (this.#hits.get(point) ?? 0) + 1;
		this.#hits.set(point, hits);
		const fault = this.#schedule.find((f) => f.point === point && f.hit === hits);
		if (fault?.kind === "kill") process.kill(process.pid, "SIGKILL");
		if (fault?.kind === "error") throw new InjectedFault(`${point} #${hits}`);
	}

	hits(point: FaultPoint): number {
		return this.#hits.get(point) ?? 0;
	}

	/** Storage whose commits pass `commit:before` and, once stored, `commit:after`. */
	storage(inner: Storage): Storage {
		const commit: Storage["commit"] = async (writes, context) => {
			this.hit("commit:before");
			const seq = await inner.commit(writes, context);
			this.hit("commit:after");
			return seq;
		};
		return new Proxy(inner, {
			get: (target, property) => {
				if (property === "commit") return commit;
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
}
