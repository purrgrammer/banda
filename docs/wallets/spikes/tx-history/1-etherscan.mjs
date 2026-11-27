// Q: what does Etherscan API v2 answer without a key for Base (8453) and Base Sepolia (84532)?
// And Blockscout's Etherscan-compatible /api, also keyless, for comparison.
import { BLOCKSCOUT, rlHeaders, trim } from "./lib.mjs";

const ADDR = process.argv[2] ?? "0xA849bbaD82F9edafDf9A5550CC874276138779d9";
const probes = [
	["etherscan v2 txlist 8453", `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=txlist&address=${ADDR}&page=1&offset=2`],
	["etherscan v2 txlist 84532", `https://api.etherscan.io/v2/api?chainid=84532&module=account&action=txlist&address=${ADDR}&page=1&offset=2`],
	["etherscan v2 tokentx 84532", `https://api.etherscan.io/v2/api?chainid=84532&module=account&action=tokentx&address=${ADDR}&page=1&offset=2`],
	["etherscan v2 proxy blockNumber 84532", "https://api.etherscan.io/v2/api?chainid=84532&module=proxy&action=eth_blockNumber"],
	["etherscan v1 basescan sepolia", `https://api-sepolia.basescan.org/api?module=account&action=txlist&address=${ADDR}&page=1&offset=2`],
	["blockscout compat tokentx", `${BLOCKSCOUT}/api?module=account&action=tokentx&address=${ADDR}&page=1&offset=2&sort=desc`],
	["blockscout compat txlistinternal", `${BLOCKSCOUT}/api?module=account&action=txlistinternal&address=${ADDR}&page=1&offset=2&sort=desc`],
];
for (const [name, url] of probes) {
	const res = await fetch(url);
	const body = await res.text();
	console.log(`${name}: HTTP ${res.status} ${JSON.stringify(rlHeaders(res.headers))}\n  ${trim(body, 260)}`);
}
