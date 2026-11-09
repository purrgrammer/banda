import { mountAvatar } from "open-bot-avatar/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { AvatarRenderer } from "./Renderer.tsx";

const hooks = vi.hoisted(() => ({
	host: { innerHTML: "", textContent: "" },
	refs: [] as { current: unknown }[],
	nextRef: 0,
	cleanup: undefined as undefined | (() => void),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	// React's refs live across renders: the component's two, in call order
	useRef: (initial: unknown) => {
		const at = hooks.nextRef++ % 2;
		hooks.refs[at] ??= { current: initial === null ? hooks.host : initial };
		return hooks.refs[at];
	},
	useEffect: (effect: () => (() => void) | undefined) => {
		hooks.cleanup = effect() ?? hooks.cleanup;
	},
}));
vi.mock("open-bot-avatar/dom", () => ({ mountAvatar: vi.fn(() => ({ update: vi.fn(), destroy: vi.fn() })) }));

const face = defaultAvatarFace();
let visibility: (entries: { isIntersecting: boolean }[]) => void;
let page: EventTarget & { hidden: boolean };
const disconnect = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	hooks.refs = [];
	hooks.nextRef = 0;
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
});
afterEach(() => {
	hooks.cleanup?.();
	hooks.cleanup = undefined;
	vi.unstubAllGlobals();
});

describe("avatar rendering lifecycle", () => {
	it("draws an idle avatar without subscribing to animation or visibility", () => {
		AvatarRenderer({ ...face, size: 40 });
		expect(hooks.host.innerHTML).toContain("<svg");
		expect(mountAvatar).not.toHaveBeenCalled();
		hooks.cleanup?.();
		expect(disconnect).not.toHaveBeenCalled();
	});

	it("animates only visible working faces and delegates system reduced motion to the library", () => {
		AvatarRenderer({ ...face, size: 40, animated: true, mood: "thinking" });
		expect(mountAvatar).not.toHaveBeenCalled();
		visibility([{ isIntersecting: true }]);
		expect(mountAvatar).toHaveBeenCalledExactlyOnceWith(hooks.host, {
			...face,
			mood: "thinking",
			reducedMotion: "system",
			label: "",
		});
		const mounted = vi.mocked(mountAvatar).mock.results[0]?.value;
		page.hidden = true;
		page.dispatchEvent(new Event("visibilitychange"));
		expect(mounted?.destroy).toHaveBeenCalledTimes(1);
		expect(hooks.host.innerHTML).toContain("<svg");
		page.hidden = false;
		page.dispatchEvent(new Event("visibilitychange"));
		expect(mountAvatar).toHaveBeenCalledTimes(2);
		visibility([{ isIntersecting: false }]);
		expect(vi.mocked(mountAvatar).mock.results[1]?.value.destroy).toHaveBeenCalledTimes(1);
	});

	it("sends a change of state to the scene on screen instead of mounting the face again", () => {
		AvatarRenderer({ ...face, size: 40, animated: true, mood: "thinking" });
		visibility([{ isIntersecting: true }]);
		const mounted = vi.mocked(mountAvatar).mock.results[0]?.value;
		AvatarRenderer({ ...face, size: 40, animated: true, mood: "happy" });
		AvatarRenderer({ ...face, size: 40, animated: false, mood: "idle" });
		expect(mountAvatar).toHaveBeenCalledTimes(1);
		expect(mounted?.destroy).not.toHaveBeenCalled();
		expect(mounted?.update).toHaveBeenCalledTimes(2);
	});

	it("falls back for malformed raw geometry without breaking the chat or retrying it on visibility", () => {
		const malformed = { ...face.definition, eyes: { ...face.definition.eyes, x: "50" } };
		expect(() => AvatarRenderer({ ...face, definition: malformed as never, size: 40, animated: true })).not.toThrow();
		expect(hooks.host.innerHTML).toContain("<svg");
		visibility([{ isIntersecting: true }]);
		page.dispatchEvent(new Event("visibilitychange"));
		expect(mountAvatar).not.toHaveBeenCalled();
	});

	it("contains an animation mount failure and does not retry the broken scene", () => {
		vi.mocked(mountAvatar).mockImplementationOnce(() => {
			throw new Error("bad scene");
		});
		AvatarRenderer({ ...face, size: 40, animated: true });
		expect(() => visibility([{ isIntersecting: true }])).not.toThrow();
		expect(hooks.host.innerHTML).toContain("<svg");
		page.dispatchEvent(new Event("visibilitychange"));
		expect(mountAvatar).toHaveBeenCalledTimes(1);
	});

	it("cleans up scenes, observers and page listeners on replacement or unmount", () => {
		AvatarRenderer({ ...face, size: 64, animated: true });
		visibility([{ isIntersecting: true }]);
		hooks.cleanup?.();
		hooks.cleanup = undefined;
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(vi.mocked(mountAvatar).mock.results[0]?.value.destroy).toHaveBeenCalledTimes(1);
		expect(hooks.host.textContent).toBe("");
		page.dispatchEvent(new Event("visibilitychange"));
		expect(mountAvatar).toHaveBeenCalledTimes(1);
	});
});
