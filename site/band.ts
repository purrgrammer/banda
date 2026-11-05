// The hero's band: each face is mounted live, follows the pointer, and drifts between its moods at its own random pace.
import { type AvatarMotion, getExample } from "open-bot-avatar";
import { mountAvatar } from "open-bot-avatar/dom";
import { BAND, GAP, HEIGHT } from "./band-layout.ts";

const MOODS: AvatarMotion[] = ["idle", "idle", "thinking", "happy"];
const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)] as T;

const row = document.querySelector<HTMLElement>(".band");
if (row) {
	row.style.gap = `${GAP}px`;
	row.style.height = `${HEIGHT}px`;
	BAND.forEach((member, index) => {
		const definition = getExample(member.shape);
		if (!definition) return;
		const host = document.createElement("span");
		host.style.cssText = `--size: ${member.size}px; --lift: ${member.lift}px; --tilt: ${member.tilt}deg; animation-delay: ${index * 60}ms`;
		row.append(host);
		const avatar = mountAvatar(host, { definition, color: member.color, mood: "idle", followPointer: true, label: "" });
		const drift = () => {
			avatar.update({ mood: pick(MOODS) });
			setTimeout(drift, 1800 + Math.random() * 4200);
		};
		setTimeout(drift, Math.random() * 2500);
	});
}
