/**
 * After every test run, what a box left behind goes: a test's home is removed after it (test/helpers.ts), so any box
 * whose home is gone is the leftover of a test that died before its own teardown. Only gone homes: another run's test
 * may be using its box right now.
 */
import { dockerAvailable, sweepBoxes } from "../src/box/container.ts";

export default function setup() {
	return async () => {
		if (await dockerAvailable()) await sweepBoxes();
	};
}
