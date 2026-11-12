import type { AvatarDefinition, AvatarMotion } from "open-bot-avatar";
import { useEffect, useRef } from "react";
import { createFaceScene, type FaceScene } from "./scene.ts";

/** A change of state reaches the scene on screen; it never mounts the face again. */
export function AvatarRenderer({
	definition,
	color,
	size,
	animated = false,
	mood = "idle",
	fill = false,
}: {
	definition: AvatarDefinition;
	color: string;
	size: number;
	animated?: boolean;
	mood?: AvatarMotion;
	/** Fill the box around it instead of `size` pixels: a face sized from the text it sits in. */
	fill?: boolean;
}) {
	const host = useRef<HTMLSpanElement>(null);
	const scene = useRef<FaceScene | undefined>(undefined);
	useEffect(() => {
		const element = host.current;
		if (!element) return;
		scene.current ??= createFaceScene(element);
		scene.current.show({ definition, color, size, animated, mood });
	}, [definition, color, size, animated, mood]);
	useEffect(() => {
		return () => {
			scene.current?.destroy();
			scene.current = undefined;
		};
	}, []);
	return fill ? (
		<span ref={host} aria-hidden="true" className="block size-full [&_svg]:block [&_svg]:size-full" />
	) : (
		<span ref={host} aria-hidden="true" className="inline-block shrink-0" style={{ width: size, height: size }} />
	);
}
