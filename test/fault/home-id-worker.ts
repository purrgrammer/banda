/**
 * The process the installation id's fault suite kills: a fresh home's id made, as the wallets area's start or a
 * provider sign-in makes it, then a wallet's keychain item written under it, in a JSON file under the home. A kill at
 * the id's boundaries (its temporary file written and flushed, the id linked into place) or at the item's write ends
 * the process where a power cut would; a thrown fault there is asked again, as the next start would. Before it does
 * anything, each process checks what the last one left: the id's file is missing or whole, and once an item names an
 * id, the home's id is that one, never another (`identityLost`). Prints a summary as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { installationId, readInstallationId } from "../../src/home.ts";
import { walletAccount } from "../../src/wallet/home-id.ts";
import { FileKeystore } from "../../src/wallet/keystore.ts";
import { addressOf, type Key } from "../../src/wallet/sign.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

/** A key invented for this suite: its address names the item. */
export const KEY = `0x${"7".repeat(64)}` as Key;

if (process.argv[1]?.endsWith("home-id-worker.ts")) await main(...(process.argv.slice(2) as [string, string]));

async function main(home: string, schedule: string): Promise<void> {
	const faults = new Faults(JSON.parse(schedule) as Fault[]);
	const path = join(home, "keychain.json");
	const keystore = new FileKeystore(path, { hit: (point) => faults.hit(point) });
	const looking = new FileKeystore(path);
	const violations: unknown[] = [];
	/** A thrown fault, as it comes back: itself, or the cause of the keychain's error it was classified as. */
	const injected = (error: unknown): boolean =>
		error instanceof InjectedFault || (error instanceof Error && error.cause !== undefined && injected(error.cause));

	/** What the process before left: an id whole or none, and every item under the id the home has. */
	async function holds(when: string): Promise<string | undefined> {
		let id: string | undefined;
		try {
			id = await readInstallationId(home);
		} catch (error) {
			violations.push({ when, damaged: (error as Error).message });
		}
		const items = await looking.find("").catch(() => [] as string[]);
		for (const item of items)
			if (id === undefined || !item.startsWith(`${id}/`)) violations.push({ when, item, id: id ?? null });
		return id;
	}

	const before = await holds("start");
	let id: string | undefined;
	for (;;) {
		try {
			id = await installationId(home, { hit: (point) => faults.hit(point) });
			if (before !== undefined && id !== before) violations.push({ when: "made", before, id });
			await keystore.write(walletAccount(id, addressOf(KEY)), KEY);
			break;
		} catch (error) {
			if (!injected(error)) throw error;
		}
	}
	await holds("end");
	const temporaries = readdirSync(join(home, "auth")).filter((entry) => entry.endsWith(".tmp"));
	console.log(JSON.stringify({ id, items: await looking.find(""), temporaries, violations, points: faults.counts() }));
}
