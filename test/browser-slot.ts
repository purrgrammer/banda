import { relative } from "node:path";
import { afterAll, expect } from "vitest";
import { BROWSERS, hold } from "./slots.ts";
// a daemon a browser test starts in process polls its networks too: one left on a shipped public RPC fails the test
import "./offline.ts";

// `ps` then says which file each test process runs, should one ever stall
process.title = `vitest ${relative(process.cwd(), expect.getState().testPath ?? "")}`;
afterAll(await hold(BROWSERS));
