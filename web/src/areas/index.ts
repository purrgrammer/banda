/**
 * Every area of the app (`<area>.ts`: its calls to the daemon, and what its shell events change), in one list that
 * already names each: an area fills its own file and never edits this one, nor `lib/shell.ts`'s handlers.
 */
import type { ShellHandlers } from "../lib/shell.ts";
import { shell as artifacts } from "./artifacts.ts";
import { shell as devices } from "./devices.ts";
import { shell as groups } from "./groups.ts";
import { shell as permissions } from "./permissions.ts";
import { shell as routines } from "./routines.ts";
import { shell as tiers } from "./tiers.ts";

export const AREA_HANDLERS: ShellHandlers = {
	...tiers,
	...permissions,
	...routines,
	...artifacts,
	...groups,
	...devices,
};
