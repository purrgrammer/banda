import { afterAll } from "vitest";
import { BROWSERS, hold } from "./slots.ts";

afterAll(await hold(BROWSERS));
