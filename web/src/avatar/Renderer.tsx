import { type AvatarDefinition, type AvatarMotion, getExample, renderAvatarSvg } from "open-bot-avatar";
import { mountAvatar } from "open-bot-avatar/dom";
import { useEffect, useRef } from "react";

/** Stills do not subscribe to the shared clock. Animated scenes exist only while visible. */
export function AvatarRenderer({
	definition,
	color,
	size,
	animated = false,
	mood = "idle",
}: {
	definition: AvatarDefinition;
	color: string;
	size: number;
	animated?: boolean;
	mood?: AvatarMotion;
}) {
	const host = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const element = host.current;
		if (!element) return;
		let visible = false;
		let mounted: ReturnType<typeof mountAvatar> | undefined;
		let failed = false;
		const fallback = () => {
			failed = true;
			mounted?.destroy();
			mounted = undefined;
			// A malformed definition must not break the surrounding chat. Never retry it on visibility changes.
			element.textContent = "";
			try {
				const safe = getExample("chat");
				if (safe) element.innerHTML = renderAvatarSvg(safe, { color: "#8a9cc7", size, reducedMotion: true });
			} catch {
				// Even a renderer failure leaves an inert, empty face rather than an uncaught effect.
			}
		};
		const still = () => {
			try {
				element.innerHTML = renderAvatarSvg(definition, { color, size, motion: mood, reducedMotion: true });
			} catch {
				fallback();
			}
		};
		const sync = () => {
			if (failed) return;
			const active = animated && visible && !document.hidden;
			try {
				if (active && !mounted) {
					mounted = mountAvatar(element, { definition, color, mood, reducedMotion: "system", label: "" });
				} else if (!active && mounted) {
					mounted.destroy();
					mounted = undefined;
					still();
				}
			} catch {
				fallback();
			}
		};
		still();
		const observer =
			animated && typeof IntersectionObserver !== "undefined"
				? new IntersectionObserver(([entry]) => {
						visible = entry?.isIntersecting ?? false;
						sync();
					})
				: undefined;
		if (observer) observer.observe(element);
		else if (animated) {
			visible = true;
			sync();
		}
		if (animated) document.addEventListener("visibilitychange", sync);
		return () => {
			observer?.disconnect();
			if (animated) document.removeEventListener("visibilitychange", sync);
			mounted?.destroy();
			element.textContent = "";
		};
	}, [definition, color, size, animated, mood]);
	return <span ref={host} aria-hidden="true" className="inline-block shrink-0" style={{ width: size, height: size }} />;
}
