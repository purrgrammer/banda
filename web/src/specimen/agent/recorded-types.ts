import type { AvatarFace } from "../../../../src/core/avatar-face.ts";
import type { ChatPrompt, Item } from "../../../../src/server/api.ts";

export type RecordedRun = {
	id: number;
	input: string;
	at?: number;
	kind: "user" | "wake";
	prompt: ChatPrompt;
	items: Item[];
};
export type RecordedActivity = { agent: { name: string; face?: AvatarFace }; capturedAt: number; runs: RecordedRun[] };
