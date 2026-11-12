/**
 * One face in the page: a still drawing, or a live scene while it moves. A change of mood goes to the scene already
 * on screen, so the library eases from the pose it holds; the scene is only replaced when it leaves the screen.
 */
import { type AvatarDefinition, type AvatarMotion, getExample, MOOD_MS, renderAvatarSvg } from "open-bot-avatar";
import { mountAvatar } from "open-bot-avatar/dom";

export type FaceView = {
	readonly definition: AvatarDefinition;
	readonly color: string;
	readonly size: number;
	readonly animated: boolean;
	readonly mood: AvatarMotion;
};

export type FaceScene = { show(view: FaceView): void; destroy(): void };

/** One hop of the library's happy motion. */
const HOP_MS = 920;

/**
 * How long a mood holds the face before another may replace it, counted from when it starts to ease in. The library's
 * moods loop with no end of their own, so this is their end: two whole hops for happy, a readable moment for thinking.
 * Thinking is the shorter, so the happy that follows a very short run is still asked for when thinking lets go.
 */
export const MOOD_BEAT_MS: Readonly<Record<AvatarMotion, number>> = {
	idle: 0,
	thinking: MOOD_MS + 1080,
	happy: MOOD_MS + 2 * HOP_MS,
};

/** Stills do not subscribe to the shared clock. A scene exists only while its face is visible. */
export function createFaceScene(element: HTMLElement): FaceScene {
	let view: FaceView | undefined;
	let mounted: ReturnType<typeof mountAvatar> | undefined;
	let shown: AvatarMotion = "idle";
	let beat: ReturnType<typeof setTimeout> | undefined;
	let failed = false;
	let visible = false;
	let watching = false;
	let observer: IntersectionObserver | undefined;

	const endBeat = () => {
		if (beat !== undefined) clearTimeout(beat);
		beat = undefined;
	};
	const startBeat = () => {
		const length = MOOD_BEAT_MS[shown];
		if (length > 0)
			beat = setTimeout(() => {
				beat = undefined;
				advance();
			}, length);
	};
	const release = () => {
		endBeat();
		mounted?.destroy();
		mounted = undefined;
	};
	const fallback = () => {
		failed = true;
		release();
		// A malformed definition must not break the surrounding chat. Never retry it on visibility changes.
		element.textContent = "";
		try {
			const safe = getExample("chat");
			if (safe && view)
				element.innerHTML = renderAvatarSvg(safe, { color: "#8a9cc7", size: view.size, reducedMotion: true });
		} catch {
			// Even a renderer failure leaves an inert, empty face rather than an uncaught effect.
		}
	};
	const still = () => {
		if (!view) return;
		try {
			element.innerHTML = renderAvatarSvg(view.definition, {
				color: view.color,
				size: view.size,
				motion: view.mood,
				reducedMotion: true,
			});
		} catch {
			fallback();
		}
	};
	/** The asked-for mood replaces the one on screen, once that one's beat is over. */
	const advance = () => {
		if (!mounted || !view || beat !== undefined || view.mood === shown) return;
		shown = view.mood;
		try {
			mounted.update({ mood: shown });
			startBeat();
		} catch {
			fallback();
		}
	};
	const unwatch = () => {
		if (!watching) return;
		watching = false;
		visible = false;
		observer?.disconnect();
		observer = undefined;
		document.removeEventListener("visibilitychange", sync);
	};
	const sync = () => {
		if (failed || !view) return;
		const onScreen = visible && !document.hidden;
		try {
			if (mounted && !onScreen) {
				release();
				still();
			} else if (!mounted && onScreen && view.animated) {
				mounted = mountAvatar(element, {
					definition: view.definition,
					color: view.color,
					mood: view.mood,
					reducedMotion: "system",
					label: "",
				});
				shown = view.mood;
				startBeat();
			}
		} catch {
			fallback();
			return;
		}
		// A scene that came to rest stays live while on screen: going still would swap the drawing and jump the pose.
		if (!mounted && !view.animated) unwatch();
	};
	const watch = () => {
		if (watching) return;
		watching = true;
		document.addEventListener("visibilitychange", sync);
		if (typeof IntersectionObserver === "undefined") {
			visible = true;
			return;
		}
		// one call brings every change since the last, oldest first: the face is where the newest says
		observer = new IntersectionObserver((entries) => {
			visible = entries.at(-1)?.isIntersecting ?? false;
			sync();
		});
		observer.observe(element);
	};

	return {
		show(next) {
			if (view && (view.definition !== next.definition || view.color !== next.color || view.size !== next.size))
				failed = false;
			view = next;
			if (next.animated) watch();
			if (failed) return;
			if (mounted) {
				try {
					// The library rebuilds its scene only if the geometry itself differs.
					mounted.update({ definition: next.definition, color: next.color });
				} catch {
					fallback();
					return;
				}
				advance();
			} else still();
			sync();
		},
		destroy() {
			unwatch();
			release();
			view = undefined;
			element.textContent = "";
		},
	};
}
