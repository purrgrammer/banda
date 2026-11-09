/** The chat's shared shapes, with no imports, so pure code and the tests can name them. */

/** What an agent's face says around it: at work, waiting on the owner, or neither. */
export type FaceState = "idle" | "working" | "waiting";

export type Who = {
	readonly face: import("../../../src/core/avatar-face.ts").AvatarFace;
	readonly name: string;
	readonly id?: string;
};

export type RowView = {
	readonly id: string;
	readonly name: string;
	/** One face for an agent; two or more for a group. */
	readonly faces: readonly (Who & { readonly state?: FaceState | undefined })[];
	readonly excerpt: string;
	/** Who said the excerpt: "You" when the owner did; in a group, the agent's name. */
	readonly by?: string | undefined;
	readonly time: string;
	readonly unread?: number | undefined;
	/** An ask open in this chat, in a few words: it replaces the excerpt. */
	readonly ask?: string | undefined;
	readonly state?: FaceState | undefined;
	readonly paused?: boolean | undefined;
};
