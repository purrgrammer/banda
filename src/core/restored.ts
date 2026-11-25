/**
 * The marker a restore leaves at the home's root (src/core/backup.ts): a random value of its own, which the home's
 * binding takes in (src/wallet/home-id.ts `homeBinding`). A restored home is then never the home it was restored from,
 * even where its folder came back at the same path with the same inode, as ext4 hands a freed inode out again and
 * Linux keeps no birth time to tell them apart: it starts without the lease, and signs again only after the owner's
 * Move signing here (UC-21). A backup does not carry it, so each restore leaves its home a marker anew.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { readMarker } from "./marker.ts";

export const RESTORED_MARKER = "restored.json";

export const Restored = Type.Object(
	{ restored: Type.String({ pattern: "^[0-9a-f]{64}$" }) },
	{ additionalProperties: false },
);

/** Marks `home` (a restore's stage) as restored, with a value no other home has. */
export async function markRestored(home: string): Promise<void> {
	const marker = { restored: randomBytes(32).toString("hex") };
	await writeFile(join(home, RESTORED_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

/** The value `home`'s restore left, or undefined for a home never restored. A marker that is not one is refused. */
export async function restoredOf(home: string): Promise<string | undefined> {
	return (await readMarker(join(home, RESTORED_MARKER), Restored, "a restore's marker"))?.restored;
}
