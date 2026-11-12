/** The connections banda ships, as tests read them: their definition files, and what one says or refuses when changed. */
import { readFileSync } from "node:fs";
import type { Tx } from "@earendil-works/pi-durable";
import { Connected } from "../../src/core/connections.ts";
import { type Definition, readDefinition, type Shipped, setDefinitions } from "../../src/core/definitions.ts";

/** The bytes of the definition banda ships of `name`. */
export const shippedText = (name: string) =>
	readFileSync(new URL(`../../shipped/connections/${name}.json`, import.meta.url), "utf8");

/** The connection the definition `text` of `name` says, its version with it. */
export function definition(name: string, text = shippedText(name)): Shipped {
	const read = readDefinition(name, text);
	if ("errors" in read) throw new Error(`${name}: ${read.errors.join("; ")}`);
	return read.connection;
}

/** Why the definition banda ships of `name` would be refused, changed by `change`; "" when it is not. */
export function refusal(name: string, change: (definition: Definition) => void): string {
	const value = JSON.parse(shippedText(name)) as Definition;
	change(value);
	const read = readDefinition(name, JSON.stringify(value));
	return "errors" in read ? read.errors.join() : "";
}

/** Make `connections` the definitions in effect in this process, as the daemon does with its release's at start. */
export function shipping(...connections: readonly Shipped[]): void {
	setDefinitions(new Map(connections.map((connection) => [connection.name, connection])));
}

/** In `tx`: `name` on in this home, as the owner adding it leaves it. */
export async function added(tx: Tx, name: string, at = 1): Promise<void> {
	(await tx.doc(Connected)).added[name] = { at };
}
