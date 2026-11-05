/** Every area's segmenter (`types.ts`), in one list that already names each: an area fills its own file. */
import { artifacts } from "./artifacts.ts";
import { avatar } from "./avatar.ts";
import { browser } from "./browser.ts";
import { changes } from "./changes.ts";
import { connect } from "./connect.ts";
import { harness } from "./harness.ts";
import { memory } from "./memory.ts";
import { reactions } from "./reactions.ts";
import { refusals } from "./refusals.ts";
import { routines } from "./routines.ts";
import type { Segmenter } from "./types.ts";
import { web } from "./web.ts";

export const SEGMENTERS: readonly Segmenter[] = [
	refusals,
	reactions,
	routines,
	artifacts,
	avatar,
	connect,
	harness,
	browser,
	web,
	memory,
	changes,
];
