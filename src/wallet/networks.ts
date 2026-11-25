/**
 * The networks a wallet can live on (docs/wallets.md "Chains, RPC and privacy"; docs/wallets/stack.md section 8): one
 * per wallet, fixed at creation. `anvil` and `anvil-usdc` are the local chains tests run on, one per chain id
 * docs/wallets/features/ISOLATION.md section 3 fixes; outside tests they do not exist. The schema still names them,
 * because a stored shape never varies by build: a doc naming one in a build resolves to no network.
 */
import { type Static, Type } from "typebox";

export const NetworkId = Type.Union([
	Type.Literal("base"),
	Type.Literal("base-sepolia"),
	Type.Literal("anvil"),
	Type.Literal("anvil-usdc"),
]);
export type NetworkId = Static<typeof NetworkId>;

/** The OP Stack predeploy whose `getL1FeeUpperBound` bounds a transaction's L1 fee. */
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";

export type Network = {
	readonly id: NetworkId;
	/** What the owner reads: "Base", "Base Sepolia". */
	readonly label: string;
	readonly chainId: number;
	/** The CAIP-2 id x402 names a network by. */
	readonly caip2: `eip155:${number}`;
	readonly testnet: boolean;
	/**
	 * The pinned USDC contract and its EIP-712 domain, which banda re-reads on chain before signing (H-250). Absent on
	 * `anvil`, a plain chain with no token on it.
	 */
	readonly usdc?: { readonly address: string; readonly decimals: 6; readonly name: string; readonly version: string };
	/**
	 * The GasPriceOracle the reserve's L1 term reads. On anvil, which charges no L1 fee of its own, the test runner etches
	 * a stub at this address with `anvil_setCode` (docs/wallets/features/ISOLATION.md section 3).
	 */
	readonly gasPriceOracle: string;
	/**
	 * The public RPC banda ships, which learns the address and the owner's IP until the owner sets another. Absent on
	 * the local chains, whose port the system assigns: a test sets `wallets.rpc.<id>`.
	 */
	readonly rpc?: string;
	/**
	 * The block explorer a row links to, opened only by the owner's tap and never fetched by banda (H-201, H-282). Absent
	 * on the local chains, which no explorer reads.
	 */
	readonly explorer?: string;
};

const BASE: Network = {
	id: "base",
	label: "Base",
	chainId: 8453,
	caip2: "eip155:8453",
	testnet: false,
	usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, name: "USD Coin", version: "2" },
	gasPriceOracle: GAS_PRICE_ORACLE,
	rpc: "https://base-rpc.publicnode.com",
	explorer: "https://basescan.org",
};

const SEPOLIA_USDC = {
	address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	decimals: 6,
	name: "USDC",
	version: "2",
} as const;

const BASE_SEPOLIA: Network = {
	id: "base-sepolia",
	label: "Base Sepolia",
	chainId: 84532,
	caip2: "eip155:84532",
	testnet: true,
	usdc: SEPOLIA_USDC,
	gasPriceOracle: GAS_PRICE_ORACLE,
	rpc: "https://sepolia.base.org",
	explorer: "https://sepolia.basescan.org",
};

/** A plain anvil at its own chain id, 31337, where transfer, lane and nonce scenarios move ETH. */
const ANVIL: Network = {
	id: "anvil",
	label: "Local chain",
	chainId: 31337,
	caip2: "eip155:31337",
	testnet: true,
	gasPriceOracle: GAS_PRICE_ORACLE,
};

/**
 * A plain anvil loaded with the x402-state spike's fixture, for x402 scenarios and any that move USDC: Base Sepolia's
 * USDC code and storage, proven only under chain id 84532 (docs/wallets/spikes/gaps/x402-state). It shares Base
 * Sepolia's chain and CAIP-2 ids, so a network is told apart by its `id`, never by its chain.
 */
const ANVIL_USDC: Network = {
	id: "anvil-usdc",
	label: "Local chain with USDC",
	chainId: BASE_SEPOLIA.chainId,
	caip2: BASE_SEPOLIA.caip2,
	testnet: true,
	usdc: SEPOLIA_USDC,
	gasPriceOracle: GAS_PRICE_ORACLE,
};

/**
 * Set by tests alone: it makes the local chains networks. A build refuses it, so a manual run against anvil (AGENTS.md
 * principle 9) runs from the sources, on a throwaway home whose `config.json` sets each local chain's RPC, since banda
 * ships no default for either: `wallets.rpc.anvil` to an anvil started with `--chain-id 31337`, and, for x402 or
 * anything that moves USDC, `wallets.rpc["anvil-usdc"]` to one started with `--chain-id 84532 --load-state` from the
 * USDC state file (`docs/wallets/spikes/gaps/x402-state/make-state.mjs` writes it). Then `npm run build:web`, and
 * `BANDA_TEST_CHAIN=1 BANDA_HOME=$(mktemp -d) node src/cli/index.ts serve --port 7788`.
 */
export const TEST_CHAIN_ENV = "BANDA_TEST_CHAIN";

/**
 * Whether this process offers the local chains: only where a test asks for it and banda runs from its TypeScript
 * sources. A build (`dist/`, which every release runs) that is asked for them throws instead. H-030 is the analogous
 * rule for a test keystore, which it excludes from a release at build time; this is a check at run time.
 */
export function offersTestChain(env: NodeJS.ProcessEnv = process.env, from: string = import.meta.url): boolean {
	if (env[TEST_CHAIN_ENV] !== "1") return false;
	if (!from.endsWith(".ts")) throw new Error(`${TEST_CHAIN_ENV} is for tests: a build never offers the local chains`);
	return true;
}

/** The networks this process offers, in the order the owner sees them. */
export function networks(env: NodeJS.ProcessEnv = process.env): readonly Network[] {
	return offersTestChain(env) ? [BASE, BASE_SEPOLIA, ANVIL, ANVIL_USDC] : [BASE, BASE_SEPOLIA];
}

/** The network named `id`, or undefined when this process does not offer it. */
export function networkOf(id: string, env: NodeJS.ProcessEnv = process.env): Network | undefined {
	return networks(env).find((one) => one.id === id);
}
