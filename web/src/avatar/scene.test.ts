import type { AvatarMotion } from "open-bot-avatar";
import { mountAvatar } from "open-bot-avatar/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { createFaceScene, type FaceScene, MOOD_BEAT_MS } from "./scene.ts";

vi.mock("open-bot-avatar/dom", () => ({ mountAvatar: vi.fn(() => ({ update: vi.fn(), destroy: vi.fn() })) }));

const face = defaultAvatarFace();
const host = () => ({ innerHTML: "", textContent: "" }) as unknown as HTMLElement;
let page: EventTarget & { hidden: boolean };
let visibility: (entries: { isIntersecting: boolean }[]) => void;
const disconnect = vi.fn();
let scene: FaceScene;

const show = (mood: AvatarMotion, animated = mood !== "idle", definition = face.definition) =>
	scene.show({ definition, color: face.color, size: 40, animated, mood });
const live = () =>
	vi.mocked(mountAvatar).mock.results[0]?.value as {
		update: ReturnType<typeof vi.fn>;
		destroy: ReturnType<typeof vi.fn>;
	};
/** Moods handed to the scene on screen, in order. */
const moods = () => live().update.mock.calls.flatMap(([options]) => (options.mood === undefined ? [] : [options.mood]));

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	page = Object.assign(new EventTarget(), { hidden: false });
	vi.stubGlobal("document", page);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: typeof visibility) {
				visibility = callback;
			}
			observe() {}
			disconnect = disconnect;
		},
	);
	scene = createFaceScene(host());
});
afterEach(() => {
	scene.destroy();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("a face changing state", () => {
	it("keeps one scene across every change of state and of face identity", () => {
		show("thinking");
		visibility([{ isIntersecting: true }]);
		vi.advanceTimersByTime(MOOD_BEAT_MS.thinking);
		show("happy");
		vi.advanceTimersByTime(MOOD_BEAT_MS.happy);
		show("idle", false);
		// the same face, as a new object from a refetch
		show("thinking", true, { ...face.definition });
		expect(mountAvatar).toHaveBeenCalledTimes(1);
		expect(live().destroy).not.toHaveBeenCalled();
		expect(moods()).toEqual(["happy", "idle", "thinking"]);
	});

	it("plays happy to the end of its beat before idle, however early idle is asked for", () => {
		show("happy");
		visibility([{ isIntersecting: true }]);
		show("idle", false);
		vi.advanceTimersByTime(MOOD_BEAT_MS.happy - 1);
		expect(moods()).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(moods()).toEqual(["idle"]);
	});

	it("lets a short thinking finish its beat, then goes on to the happy that was asked for, then idle", () => {
		show("thinking");
		visibility([{ isIntersecting: true }]);
		vi.advanceTimersByTime(100);
		show("happy");
		expect(moods()).toEqual([]);
		vi.advanceTimersByTime(MOOD_BEAT_MS.thinking - 100);
		expect(moods()).toEqual(["happy"]);
		show("idle", false);
		vi.advanceTimersByTime(MOOD_BEAT_MS.happy - 1);
		expect(moods()).toEqual(["happy"]);
		vi.advanceTimersByTime(1);
		expect(moods()).toEqual(["happy", "idle"]);
	});

	it("holds thinking for less than happy, so a very short run's happy is still asked for when thinking lets go", () => {
		expect(MOOD_BEAT_MS.thinking).toBeLessThan(MOOD_BEAT_MS.happy);
	});

	it("goes from idle straight into the next mood, with no beat to wait for", () => {
		show("thinking");
		visibility([{ isIntersecting: true }]);
		vi.advanceTimersByTime(MOOD_BEAT_MS.thinking);
		show("idle", false);
		show("thinking");
		expect(moods()).toEqual(["idle", "thinking"]);
	});

	// the browser queues the changes since its last call: off screen when watched, on screen once the feed scrolled to it
	it("goes by the newest of the changes one call of the observer brings", () => {
		show("thinking");
		visibility([{ isIntersecting: false }, { isIntersecting: true }]);
		expect(mountAvatar).toHaveBeenCalledTimes(1);
		visibility([{ isIntersecting: true }, { isIntersecting: false }]);
		expect(live().destroy).toHaveBeenCalledTimes(1);
	});

	it("stays live at rest while on screen, and only then goes still and stops watching", () => {
		show("thinking");
		visibility([{ isIntersecting: true }]);
		vi.advanceTimersByTime(MOOD_BEAT_MS.thinking);
		show("idle", false);
		expect(live().destroy).not.toHaveBeenCalled();
		expect(disconnect).not.toHaveBeenCalled();
		visibility([{ isIntersecting: false }]);
		expect(live().destroy).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it("does not hold a mood the page cannot see, and drops the beat with its scene", () => {
		show("happy");
		visibility([{ isIntersecting: true }]);
		page.hidden = true;
		page.dispatchEvent(new Event("visibilitychange"));
		expect(live().destroy).toHaveBeenCalledTimes(1);
		show("idle", false);
		expect(vi.getTimerCount()).toBe(0);
		expect(moods()).toEqual([]);
	});

	it("leaves no timer or listener behind when the face goes away mid-beat", () => {
		show("happy");
		visibility([{ isIntersecting: true }]);
		scene.destroy();
		expect(vi.getTimerCount()).toBe(0);
		expect(live().destroy).toHaveBeenCalledTimes(1);
		page.dispatchEvent(new Event("visibilitychange"));
		expect(mountAvatar).toHaveBeenCalledTimes(1);
	});
});
