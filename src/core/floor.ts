/**
 * The floor (DESIGN.md "Messages"): what no permission ever covers, so it asks every time. Words only, no store, so the app
 * shares them.
 */
/** The classes a connection's definition may put a tool under. */
export type DefinedFloor = "money" | "credentials" | "account" | "private";

/** A class of the floor: a definition's, or the owner's own (a read set to Ask, a write set to Always ask). */
export type Floor = DefinedFloor | "owner";

export const FLOORS: readonly DefinedFloor[] = ["money", "credentials", "account", "private"];

/** Why an effect on the floor asks every time, in words. */
export const FLOOR_WORDS: { readonly [floor in Floor]: string } = {
	money: "it moves money",
	credentials: "it touches a password or a key",
	account: "it changes an account",
	private: "it sends private data to someone you have not approved",
	owner: "you asked to be asked every time",
};
