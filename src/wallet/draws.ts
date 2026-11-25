/**
 * The random draws the modules that hold a key make for anything but a key (H-002): a canary's value and slot, a home
 * secret, a temp file's name. Those modules may name no random source themselves (biome/random.grit), so a draw of a
 * weak source cannot reach key generation, which is noble's `randomSecretKey` alone (src/wallet/sign.ts). Each draw
 * here is named for its one use, and each comes from node's secure source.
 */
import { randomBytes, randomInt } from "node:crypto";

/** A canary's value: 16 random bytes in hex, read back to prove the keychain keeps a write. */
export const canaryValue = (): string => randomBytes(16).toString("hex");

/** The canary slot a call tries first, of `slots`. */
export const canarySlot = (slots: number): number => randomInt(slots);

/** A fresh home secret: 32 random bytes in hex. */
export const homeSecretValue = (): string => randomBytes(32).toString("hex");

/** A temp file's suffix, so two writers in one process never share one. */
export const tempSuffix = (): string => randomBytes(4).toString("hex");
