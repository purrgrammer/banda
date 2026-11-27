/**
 * Micro-spike: what banda's existing permission, draft, connection and credential code does with a wallet's call,
 * imported read-only from the repo (no edit to src/). Each check prints PASS/FAIL with what it observed.
 *
 * Run: node --experimental-strip-types check.ts <repo>
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
if (repo === undefined) throw new Error("usage: check.ts <repo>");
const load = (path: string) => import(pathToFileURL(join(repo, path)).href);

const { draftOf } = await load("src/core/ask.ts");
const { matches, offeredScopes, refusal } = await load("src/core/permissions.ts");
const { connectionOf, fits, secrets, scrub, accountKey, accountLabel, toolName } = await load(
	"src/core/connections.ts",
);

let failed = 0;
const check = (name: string, ok: boolean, seen: unknown) => {
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${typeof seen === "string" ? seen : JSON.stringify(seen)}`);
};

// A wallet send as an EffectTool would declare it: the account (bound structurally, as every connection write binds
// its account arg, capabilities.ts:939), and a permission that binds the recipient only (chain + to), never the amount.
const ana = "0x12aB34cD56eF7890aBcDeF1234567890AbCdEf12"; // invented, mixed case like EIP-55 output
const account = { key: "0xwallet-a", generation: "g1" };
const send = {
	name: "wallet__send",
	description: "",
	parameters: {},
	effect: "idempotent" as const,
	describe: (a: { to: string; amount: string; token: string }) => `Pay ${a.amount} ${a.token} to ${a.to}`,
	permission: {
		bind: ["account"],
		args: ["chain", "to"],
		lasts: ["always"],
		what: (a: { to: string }) => `pay ${a.to}, up to what is in the wallet`,
	},
	run: async () => ({ output: [] }),
};
const call = { account, chain: "eip155:84532", to: ana, token: "USDC", amount: "1.00" };
const draft = draftOf(send, call);
check("draftOf binds account+chain+to, not amount/token", JSON.stringify(Object.keys(draft.permission.match).sort()) === '["account","chain","to"]', draft.permission.match);

const permission = {
	tool: "wallet__send",
	match: draft.permission.match,
	what: draft.permission.what,
	scope: "always",
	agent: "mara",
	at: 0,
	wait: 1,
};
const covers = (args: object, agent = "mara") => matches(permission, { tool: "wallet__send", args, agent });
check("Always covers the same recipient, any amount and token", covers({ ...call, amount: "999999", token: "ETH" }), "covered");
check("Always does not cover another recipient", !covers({ ...call, to: "0x9f00000000000000000000000000000000000001" }), "not covered");
check("Always does not cover another agent on the same wallet", !covers(call, "ledger"), "not covered: a permission binds one agent");
check("Always does not cover the wallet re-created (new generation)", !covers({ ...call, account: { ...account, generation: "g2" } }), "not covered");
check(
	"same address in lowercase is NOT covered (canonical JSON compare): expand must canonicalize",
	!covers({ ...call, to: ana.toLowerCase() }),
	`checksummed ${ana} vs ${ana.toLowerCase()}`,
);

const offered = offeredScopes({ permission: draft.permission });
check("lasts:[always] offers only Always", JSON.stringify(offered.map((s: { scope: string }) => s.scope)) === '["always"]', offered);
check("an interrupted run offers no scope", offeredScopes({ permission: draft.permission, interrupted: true }).length === 0, "[]");
check("a draft on the money floor offers no scope", offeredScopes({ permission: draft.permission, floor: "money" }).length === 0, "[]");
check("a task scope not offered is refused", refusal({ scope: "task" }, draft.permission, undefined, 0, offered) === "that was not offered", refusal({ scope: "task" }, draft.permission, undefined, 0, offered));
check("money floor refuses Always", typeof refusal({ scope: "always" }, draft.permission, "money", 0) === "string", refusal({ scope: "always" }, draft.permission, "money", 0));

// Where a built-in adapter plugs in today: `api` must name a REST_APIS entry signed in with OAuth.
const asBuiltIn = connectionOf("wallet", {
	service: "Wallet",
	url: "https://sepolia.base.org",
	api: "wallet",
	auth: "key",
	reads: ["address", "balance"],
	floors: {},
});
check("a built-in `api: wallet` with auth key is refused by connectionOf", "errors" in asBuiltIn, asBuiltIn.errors ?? asBuiltIn);
const asKeyServer = connectionOf("wallet", { service: "Wallet", url: "https://sepolia.base.org", auth: "key", reads: [], floors: {} });
check("auth key without api parses (a plain remote MCP server)", "connection" in asKeyServer, "connection" in asKeyServer ? "parsed" : asKeyServer);

// auth: key credentials are bound to the connection URL (the RPC endpoint, for a wallet).
const conn = asKeyServer.connection;
const ref = { url: "https://sepolia.base.org", key: "kc-7f3a9c" };
check("a key reference fits while the URL is the same", fits(ref, conn) === true, "fits");
check("a key reference stops fitting when the RPC URL changes", fits(ref, { ...conn, url: "https://base-sepolia.example-rpc.org" }) === false, "does not fit: wallet offline");

// secrets() and scrub() on a home with wallet credentials.
const home = await mkdtemp(join(tmpdir(), "banda-spike-home-"));
try {
	const dir = join(home, "auth", "connections", "wallet", accountKey(ana));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "credentials.json"), JSON.stringify({ url: ref.url, key: `kc:${ana}` }));
	const prefixed = scrub(`paid from ${ana} to Ana`, await secrets(home));
	check("a reference that only contains the address leaves the bare address visible (scrub matches the whole key)", prefixed.includes(ana), prefixed);
	await writeFile(join(dir, "credentials.json"), JSON.stringify({ url: ref.url, key: ana }));
	const bare = scrub(`paid from ${ana} to Ana`, await secrets(home));
	check("a reference that IS the address hides the address in every output", !bare.includes(ana), bare);

	await writeFile(join(dir, "credentials.json"), JSON.stringify({ keychain: { service: "banda-wallet-x", account: "y" }, address: ana }));
	let threw: string | undefined;
	try {
		await secrets(home);
	} catch (error) {
		threw = (error as Error).message;
	}
	check("a new credentials shape (neither key nor oauth) crashes secrets() as the code stands", threw !== undefined, threw ?? "no throw");
} finally {
	await rm(home, { recursive: true, force: true });
}

check("an address account key is the lowercase address", accountKey(ana) === ana.toLowerCase(), accountKey(ana));
check("an unlabeled wallet reads as @0x… to the owner and model", accountLabel({ id: ana }) === `@${ana}`, accountLabel({ id: ana }));
check("tool names", toolName("wallet", "send") === "wallet__send" && toolName("wallet", "pay_x402") === "wallet__pay_x402", [toolName("wallet", "send"), toolName("wallet", "pay_x402")]);

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
