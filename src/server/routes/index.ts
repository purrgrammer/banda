/**
 * Every area of the daemon (`area.ts`), in one list that already names each: an area fills its own file and never
 * edits this one.
 */
import type { AreaModule } from "./area.ts";
import { artifacts } from "./artifacts.ts";
import { band } from "./band.ts";
import { faces } from "./faces.ts";
import { groups } from "./groups.ts";
import { harnessesArea } from "./harnesses.ts";
import { permissions } from "./permissions.ts";
import { proposals } from "./proposals.ts";
import { providers } from "./providers.ts";
import { routines } from "./routines.ts";
import { search } from "./search.ts";
import { tiers } from "./tiers.ts";
import { usage } from "./usage.ts";
import { watches } from "./watches.ts";

export const AREAS: readonly AreaModule[] = [
	tiers,
	providers,
	usage,
	permissions,
	routines,
	watches,
	artifacts,
	groups,
	proposals,
	search,
	faces,
	harnessesArea,
	band,
];
