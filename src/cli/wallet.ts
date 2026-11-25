/**
 * `banda wallet`, on the host's terminal (UC-01, UC-02): `list` prints the home's wallets, each address in its short
 * form alone; `receive` gives one wallet's whole address as Receive does (H-005, H-157, C17); `create` makes one, takes the creation's one reveal with the secret
 * its answer carried (C16) and prints the key beside the address it opens, for the owner to save. The key is in this
 * process and the terminal alone: the signer child wrote it onto the connection, never the daemon (C20), and `create`
 * runs only with a terminal at both ends, so no pipe, file or log captures the key (UC-02, C16). Loaded only by
 * `banda wallet`, so other commands start as quickly.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { WalletMade, WalletReceive, WalletRevealed, WalletsView, WalletView } from "../server/api.ts";
import { nameKey, shortAddress } from "../wallet/label.ts";
import { call, Refused } from "./daemon.ts";

/**
 * A wallet's line: its address in its short form alone, whatever its state. A whole address leaves banda only through
 * Receive (`banda wallet receive`), which marks it disclosed on disk first (C17, C21) and checks that no code runs at
 * it (H-157): an address copied from a list would leave with neither.
 */
const line = (wallet: WalletView) =>
	`${shortAddress(wallet.address)}\t${wallet.network}\t${wallet.state === "ready" ? wallet.backup : wallet.state}\t${wallet.name}`;

/**
 * The wallet `asked` names: by its whole address, or by its name when one wallet has it, matched as the daemon, the
 * agent tool and the app match a typed name (`nameKey`: in any case, width or spacing, H-041).
 */
const chosen = (wallets: readonly WalletView[], asked: string): WalletView => {
	const byAddress = wallets.find((wallet) => wallet.address.toLowerCase() === asked.toLowerCase());
	if (byAddress !== undefined) return byAddress;
	const named = wallets.filter((wallet) => nameKey(wallet.name) === nameKey(asked));
	if (named.length === 1) return named[0] as WalletView;
	throw new Error(
		named.length === 0
			? `there is no wallet named ${asked}`
			: `${named.length} wallets are named ${asked}: name it by its address`,
	);
};

/**
 * The refusals of a creation that is under way, not refused: its ready commit is not on disk yet (`unsynced`), or the
 * keychain was silent at its read-back (`creating`). The same request again finishes it, and its answer is the one
 * that carries the creation's reveal (C14, C16): a new request would make a second wallet instead (H-007).
 */
const UNFINISHED = new Set(["unsynced", "creating"]);

/** How many times `create` sends the same request while the creation is under way, and how long it waits between. */
const CREATE_TRIES = 5;
const CREATE_WAIT_MS = 2_000;

/**
 * How many times `create` asks for the key again, on its own, while the daemon answers that it couldn't show it yet
 * (503: the keychain locked, its prompt dismissed, no answer in time, the spend not yet safe on disk), before it waits
 * for the owner to say go. The secret is this process's alone, and no later answer carries it (C16, H-268): it is
 * dropped only once the daemon says the reveal is gone (403) or its ten minutes pass.
 */
const REVEAL_TRIES = 3;

/** Asks the owner, at the terminal, whether to try again: true for Enter (or y), false for anything else or no input. */
const askAgain = async (said: string): Promise<boolean> => {
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await terminal.question(`${said}\nPress Enter to try again, or type n to stop: `);
		return /^\s*(y(es)?)?\s*$/i.test(answer);
	} catch {
		return false;
	} finally {
		terminal.close();
	}
};

/** A creation's request id: what `--request` takes back to finish one an earlier run left under way. */
const REQUEST = /^[\w-]{8,128}$/;

/** Why `banda wallet receive` gives no address, one sentence for each reason the daemon answers (H-317). */
export function receiveRefused(name: string, receive: Exclude<WalletReceive, { readonly state: "ready" }>): string {
	switch (receive.state) {
		case "save_first":
			return `save ${name}'s key first, or skip saving it, in the app (Settings, Wallets): until then no payment is asked for`;
		case "code":
			return `code runs at ${name}'s address: banda gives no address to pay into. See the wallet in the app`;
		case "unopenable":
			return `no key on this computer opens ${name} and its key was never saved: don't send anything to it, since nothing sent there could be spent`;
		case "key_unchecked":
			return `banda could not check ${name}'s key: your keychain didn't answer. Unlock it and run the command again; no address is given until the key is checked`;
		case "unchecked":
			return `banda could not check ${name}'s address on its network: no address is given until it can, try again`;
	}
}

/** Runs `banda wallet <action>`; answers the exit code. */
export async function walletCommand(
	home: string,
	action: string | undefined,
	rest: readonly string[],
	options: {
		readonly network?: string;
		/** Whether the owner is at a terminal, reading and typing: what a key may be printed to. */
		readonly terminal?: boolean;
		/** `create`: the request id of a creation an earlier run left under way, to finish that one, not make another. */
		readonly request?: string;
		/** `create`: waits this long between sending its request again; a test passes a shorter one. */
		readonly wait?: (ms: number) => Promise<void>;
		/** `create`: asks the owner whether to ask for the key again, once it was refused for now; a test answers. */
		readonly again?: (said: string) => Promise<boolean>;
	},
	print: (text: string) => void = console.log,
): Promise<number> {
	const terminal = options.terminal ?? (process.stdout.isTTY === true && process.stdin.isTTY === true);
	if (action === "create" && !terminal)
		throw new Error(
			"wallet create prints the new wallet's key: run it in a terminal, not a pipe or a script, or make the wallet in the app",
		);
	if (action === "list") {
		if (rest.length > 0) throw new Error("wallet list takes no argument");
		const { wallets } = (await call(home, "GET", "/api/wallets")) as WalletsView;
		for (const each of wallets) print(line(each));
		return 0;
	}
	if (action === "receive") {
		const asked = rest.join(" ").trim();
		if (asked === "") throw new Error("wallet receive needs the wallet's name or address");
		const { wallets } = (await call(home, "GET", "/api/wallets")) as WalletsView;
		const wallet = chosen(wallets, asked);
		// the daemon marks the address shown, on disk, and checks it runs no code before it answers with it
		const receive = (await call(home, "POST", `/api/wallets/${wallet.address}/receive`)) as WalletReceive;
		if (receive.state === "ready") {
			print(`${receive.address}\t${receive.network}\t${wallet.name}`);
			return 0;
		}
		throw new Error(receiveRefused(wallet.name, receive));
	}
	if (action === "create") {
		const name = rest.join(" ").trim();
		if (name === "") throw new Error("wallet create needs the wallet's name");
		// the owner picks the network (UC-01): none is assumed, so a wallet is never made on a mainnet by default
		if (options.network === undefined)
			throw new Error("wallet create needs --network <id>: base, base-sepolia, or another banda offers");
		if (options.request !== undefined && !REQUEST.test(options.request))
			throw new Error("--request takes the request id an earlier wallet create printed");
		const id = options.request ?? randomBytes(16).toString("hex");
		const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		let made: WalletMade | undefined;
		// a creation under way is finished by the same request, never a new one: its answer carries the key's reveal
		for (let tries = 1; made === undefined; tries++) {
			try {
				made = (await call(home, "POST", "/api/wallets", {
					request: id,
					name,
					network: options.network,
				})) as WalletMade;
			} catch (error) {
				if (!(error instanceof Refused && error.status === 503 && UNFINISHED.has(error.code ?? ""))) throw error;
				if (tries >= CREATE_TRIES)
					throw new Error(
						`${error.message.replace(/[.:]?\s*try again\.?$/i, "")}: the wallet isn't finished yet. Finish this same one, and see its key, with: banda wallet create --network ${options.network} --request ${id} ${name}`,
					);
				await wait(CREATE_WAIT_MS);
			}
		}
		if (made.reveal === undefined)
			throw new Error(`made ${made.wallet.name}, but its key can't be shown here: see it in banda's desktop app`);
		const reveal = made.reveal;
		const again = options.again ?? askAgain;
		let shown: WalletRevealed | undefined;
		// the secret stays live until the daemon says the reveal is gone (403) or its ten minutes pass: a refusal for now
		// (503) is asked again, a few times on its own, then each time the owner says go
		for (let tries = 1; shown === undefined; tries++) {
			try {
				shown = (await call(home, "POST", `/api/wallets/${made.wallet.address}/reveal`, {
					request: id,
					secret: reveal.secret,
				})) as WalletRevealed;
			} catch (error) {
				if (!(error instanceof Refused && error.status === 503)) throw error;
				if (Date.now() >= reveal.expires)
					throw new Error(`made ${made.wallet.name}, but its key's ten minutes passed before it could be shown`);
				if (tries < REVEAL_TRIES) {
					await wait(CREATE_WAIT_MS);
					continue;
				}
				if (!(await again(`banda couldn't show ${made.wallet.name}'s key yet: ${error.message}`)))
					throw new Error(
						`made ${made.wallet.name}, but its key wasn't shown: ${error.message}. Only banda's desktop app on a Mac with Touch ID shows it later`,
					);
			}
		}
		print(
			[
				// short, as the app's save step shows it: the whole address leaves banda only through Receive, once the key was
				// saved or the step skipped, and Receive marks it disclosed first (H-005, C17)
				`made ${made.wallet.name} on ${made.wallet.network}: ${shortAddress(shown.address)}`,
				"",
				"Its private key, shown this once. Save it somewhere safe now: whoever has it has the wallet's funds,",
				"and banda keeps no other copy than this computer's keychain.",
				"",
				`  ${shown.key}`,
				"",
				"Wallet apps such as MetaMask open it as a private key (Import account → Private key).",
				"There is no seed phrase: this key is the whole wallet.",
				"",
				"Then confirm the copy in the app (Settings, Wallets), or skip saving it there.",
			].join("\n"),
		);
		return 0;
	}
	throw new Error("wallet needs create --network <id> <name>, receive <name>, or list");
}
