/**
 * How fresh the wallets' incoming rows are (stack.md section 7): a network is read every 40 s while nobody looks, and
 * about every 2 s while a wallet screen that shows it is open (a wallet's page, its Receive). A screen says it is open
 * by looking at the network, which lasts `LOOK_MS` and which the screen renews every `LOOK_RENEW_MS` while it stays
 * open; the daemon (src/wallet/indexer.ts) and the app (web/src/areas/wallets.ts) both take these from here.
 */

/** How often a network is read while no open screen looks at it, in ms. */
export const IDLE_MS = 40_000;

/** How often a network an open screen looks at is read, in ms. */
export const LOOKING_MS = 2_000;

/** How long one look lasts, in ms: a screen closed without a word stops the fast reads within this. */
export const LOOK_MS = 15_000;

/** How often an open screen renews its look, in ms: well inside `LOOK_MS`, so one late renewal drops no tick. */
export const LOOK_RENEW_MS = 5_000;
