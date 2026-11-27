// Gap H: what @napi-rs/keyring 2.1.2's findCredentials returns, for the orphan listing ("no keychain item is left
// without a record"). Only items under a service named banda-spike-<16 random hex> are written, read and deleted;
// the query names that service, so no other item is touched. Secrets are random and never printed.
import { randomBytes } from "node:crypto";
import { Entry, findCredentials, findCredentialsAsync } from "@napi-rs/keyring";

const OPTS = process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined;
const S = `banda-spike-${randomBytes(8).toString("hex")}`;
const S2 = `${S}-other`;
const items = [
	[S, "home-test/wallet/0x00000000000000000000000000000000000000a1"],
	[S, "home-test/wallet/0x00000000000000000000000000000000000000b2"],
	[S2, "home-test/wallet/0x00000000000000000000000000000000000000c3"],
];
const secret = () => `0x${randomBytes(32).toString("hex")}`;
const ms = (t) => `${(performance.now() - t).toFixed(1)} ms`;
const written = new Map();
const show = (label, list, expect) => {
	const ok = list.every((c) => written.get(c.account) === c.password);
	console.log(`  ${label}: ${list.length} credential(s) ${JSON.stringify(list.map((c) => c.account.slice(-4)))}; each carries the secret: ${list.length ? ok : "-"}${expect !== undefined ? `; expected ${expect}` : ""}`);
};
console.log(`platform ${process.platform}-${process.arch}, node ${process.version}, service banda-spike-<16 hex>`);
try {
	for (const [svc, acct] of items) { const s = secret(); new Entry(svc, acct, OPTS).setPassword(s); written.set(acct, s); }
	let t = performance.now();
	const all = findCredentials(S);
	console.log(`  findCredentials(service) took ${ms(t)}`);
	show("findCredentials(service)", all, 2);
	show("findCredentialsAsync(service)", await findCredentialsAsync(S), 2);
	show("findCredentials(service + \"-other\")", findCredentials(S2), 1);
	show("findCredentials(a prefix of the service)", findCredentials(S.slice(0, -2)), "0 if the match is exact");
	show("findCredentials(a service never written)", findCredentials(`banda-spike-${randomBytes(8).toString("hex")}`), 0);
	const s = secret(); new Entry(...items[0], OPTS).setPassword(s); written.set(items[0][1], s);
	show("after overwriting one item", findCredentials(S), "2, the new secret");
	new Entry(...items[0], OPTS).deletePassword();
	show("after deleting one item", findCredentials(S), 1);
} catch (e) {
	console.log(`  error: ${e?.code ?? ""} ${e?.message ?? e}`);
} finally {
	for (const [svc, acct] of items) { try { new Entry(svc, acct, OPTS).deletePassword(); } catch {} }
	const left = [...findCredentials(S), ...findCredentials(S2)].length + items.filter(([svc, acct]) => new Entry(svc, acct, OPTS).getPassword() != null).length;
	console.log(`cleanup: ${left} item(s) left under the spike's services`);
}
