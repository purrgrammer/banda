/**
 * The floor (DESIGN.md "Messages"): what no permission ever covers, so it asks every time. Words only, no store, so the app
 * shares them.
 */
export type Floor = "money" | "credentials" | "account" | "private";

export const FLOORS: readonly Floor[] = ["money", "credentials", "account", "private"];

/** Why an effect on the floor asks every time, in words. */
export const FLOOR_WORDS: { readonly [floor in Floor]: string } = {
	money: "it moves money",
	credentials: "it touches a password or a key",
	account: "it changes an account",
	private: "it sends private data to someone you have not approved",
};
