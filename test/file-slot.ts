import { afterAll } from "vitest";
import { FILES, hold } from "./slots.ts";

afterAll(await hold(FILES));
