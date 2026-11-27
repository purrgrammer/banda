// Shared helpers: an anvil fork of Base Sepolia on a free port, viem clients, fork USDC.
// Test keys only: the payer and payee keys are generated per run; the facilitator is anvil's public dev account 1.
import { spawn } from "node:child_process";
import net from "node:net";
import {
	createPublicClient, createWalletClient, createTestClient, http, publicActions,
	encodeAbiParameters, keccak256, parseAbi,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (Circle), FiatToken proxy
export const CHAIN_ID = 84532;
export const UPSTREAM = process.env.FORK_URL ?? "https://sepolia.base.org";
// anvil's well-known dev account 1 (public key material, funded only on the local node)
const ANVIL_DEV_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export const usdcAbi = parseAbi([
	"function name() view returns (string)",
	"function version() view returns (string)",
	"function DOMAIN_SEPARATOR() view returns (bytes32)",
	"function balanceOf(address) view returns (uint256)",
	"function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
	"function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
	"function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
	"event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
	"event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
]);

export const freePort = () =>
	new Promise((resolve, reject) => {
		const s = net.createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

export async function startAnvil({ fork = true } = {}) {
	const port = await freePort();
	const args = ["--port", String(port), "--silent"];
	let forkBlock;
	if (fork) {
		const upstream = createPublicClient({ transport: http(UPSTREAM) });
		forkBlock = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : (await upstream.getBlockNumber()) - 10n;
		args.push("--fork-url", UPSTREAM, "--fork-block-number", String(forkBlock));
	} else {
		args.push("--chain-id", String(CHAIN_ID));
	}
	const proc = spawn("anvil", args, { stdio: ["ignore", "ignore", "inherit"] });
	const rpc = `http://127.0.0.1:${port}`;
	const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
	for (let i = 0; i < 100; i++) {
		try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
	}
	const stop = () => { try { proc.kill("SIGTERM"); } catch {} };
	process.on("exit", stop);
	return { rpc, port, forkBlock, pub, stop, proc };
}

export function clients(rpc) {
	const transport = http(rpc);
	const pub = createPublicClient({ chain: baseSepolia, transport });
	const test = createTestClient({ chain: baseSepolia, mode: "anvil", transport });
	const payer = privateKeyToAccount(generatePrivateKey());
	const payee = privateKeyToAccount(generatePrivateKey()).address;
	const other = privateKeyToAccount(generatePrivateKey()).address;
	const facAccount = privateKeyToAccount(ANVIL_DEV_1);
	const fac = createWalletClient({ chain: baseSepolia, transport, account: facAccount }).extend(publicActions);
	return { pub, test, payer, payee, other, facAccount, fac };
}

// Find the balance mapping slot of the token by probing (FiatToken v2.2 keeps balance in the low 255 bits).
let balanceSlot;
export async function setUsdc(pub, test, who, amount) {
	const write = (slot) => test.setStorageAt({
		address: USDC,
		index: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, BigInt(slot)])),
		value: `0x${amount.toString(16).padStart(64, "0")}`,
	});
	if (balanceSlot !== undefined) return write(balanceSlot);
	for (let slot = 0; slot < 30; slot++) {
		await write(slot);
		if ((await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [who] })) === amount) {
			balanceSlot = slot;
			return slot;
		}
		await test.setStorageAt({
			address: USDC,
			index: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, BigInt(slot)])),
			value: `0x${"0".repeat(64)}`,
		});
	}
	throw new Error("balance slot not found");
}

export const usdc = (pub, who) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [who] });
export const fmt = (v) => `${(Number(v) / 1e6).toFixed(6)} USDC`;
export const short = (e) => (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0];
export function revertReason(e) {
	const m = e?.cause?.reason ?? e?.cause?.data?.args?.[0] ?? e?.walk?.((c) => c?.reason)?.reason;
	return m ?? short(e);
}
