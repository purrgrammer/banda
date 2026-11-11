import { relative } from "node:path";
import { afterAll, expect } from "vitest";
import { FILES, hold } from "./slots.ts";

// `ps` then says which file each test process runs, should one ever stall
process.title = `vitest ${relative(process.cwd(), expect.getState().testPath ?? "")}`;
afterAll(await hold(FILES));
