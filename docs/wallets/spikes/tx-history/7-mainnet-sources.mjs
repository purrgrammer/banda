// Q: which history sources answer keyless for Base mainnet (what production would use)? Read-only.
import { rlHeaders, trim } from "./lib.mjs";
const A = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // mainnet USDC contract, a public address
for (const [name, url] of [
	["base.blockscout.com REST v2", `https://base.blockscout.com/api/v2/addresses/${A}/counters`],
	["api.blockscout.com multichain (8453)", `https://api.blockscout.com/8453/api/v2/addresses/${A}/counters`],
	["api.blockscout.com multichain (84532)", `https://api.blockscout.com/84532/api/v2/addresses/${A}/counters`],
	["etherscan v2 (8453)", `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=txlist&address=${A}&page=1&offset=1`],
]) {
	const r = await fetch(url, { headers: { accept: "application/json" } });
	const body = await r.text();
	console.log(`${name}: HTTP ${r.status} cf-mitigated=${r.headers.get("cf-mitigated")} rl=${JSON.stringify(rlHeaders(r.headers))}\n  ${trim(body.replace(/\s+/g, " "), 200)}`);
}
