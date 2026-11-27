// Side check for gap B: do anvil's public development accounts behave as fresh EOAs on a Base fork? Read-only.
import { rpcAt, num } from "../lib.mjs";
const DEV = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"];
for (const [name, url] of [["Base Sepolia", "https://sepolia.base.org"], ["Base mainnet", "https://mainnet.base.org"]]) {
	const rpc = rpcAt(url);
	console.log(`## ${name}, read ${new Date().toISOString()}`);
	for (const [i, a] of DEV.entries()) {
		const code = (await rpc("eth_getCode", [a, "latest"])).result;
		const nonce = num((await rpc("eth_getTransactionCount", [a, "latest"])).result);
		const kind = code === "0x" ? "no code" : code.startsWith("0xef0100") ? `EIP-7702 delegation to ${code.slice(8, 14)}…` : `${(code.length - 2) / 2} bytes of code`;
		console.log(`  dev account ${i}: ${kind}; nonce ${nonce > 0 ? "above 0" : "0"}`);
	}
}
