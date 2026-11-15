/**
 * The computer's images come only from the bundle's verified archives (src/box/microvm.ts `image`): an image already under
 * an image's name is used only when it is the bundle's, and one an earlier version loaded there is replaced, not refused.
 */
import { describe, expect, it } from "vitest";
import { image } from "../src/box/microvm.ts";
import type { MicrovmAssets } from "../src/box/microvm-assets.ts";

const asset = {
	archive: "/bundle/box.tar",
	ref: "banda-box:8abb9b1df49e",
	digest: "sha256:new",
} as MicrovmAssets["box"];

/** A runtime holding `held` under the box's name, whose archive loads `loads`; it says what it was asked. */
function runtime(held: string | undefined, loads = asset.digest) {
	let present = held;
	const asked: string[] = [];
	const run = async (args: readonly string[]) => {
		asked.push(args.slice(0, 2).join(" "));
		if (args[0] === "image" && args[1] === "inspect") {
			if (present === undefined) throw new Error(`image not found: ${asset.ref}`);
			return JSON.stringify({
				digest: `manifest-of-${present}`,
				config: { digest: present },
				architecture: "arm64",
				os: "linux",
			});
		}
		if (args[0] === "image" && args[1] === "remove") present = undefined;
		if (args[0] === "load") present = loads;
		return "";
	};
	return { computer: { run, assets: { target: "darwin-arm64" } } as unknown as Parameters<typeof image>[0], asked };
}

const signal = new AbortController().signal;

describe("the computer's images", () => {
	it("loads an image that is not there from its archive", async () => {
		const { computer, asked } = runtime(undefined);
		let built = 0;
		expect(await image(computer, asset, () => built++, signal)).toBe("manifest-of-sha256:new");
		expect(asked).toEqual(["image inspect", "load --input", "image inspect"]);
		expect(built).toBe(1);
	});

	it("uses the image there when it is the bundle's, loading nothing", async () => {
		const { computer, asked } = runtime(asset.digest);
		expect(await image(computer, asset, () => {}, signal)).toBe("manifest-of-sha256:new");
		expect(asked).toEqual(["image inspect"]);
	});

	it("replaces an earlier version's image under the same name from the archive", async () => {
		const { computer, asked } = runtime("sha256:old");
		expect(await image(computer, asset, () => {}, signal)).toBe("manifest-of-sha256:new");
		expect(asked).toEqual(["image inspect", "image remove", "load --input", "image inspect"]);
	});

	it("refuses an archive that does not load the bundle's image", async () => {
		const { computer } = runtime("sha256:old", "sha256:tampered");
		await expect(image(computer, asset, () => {}, signal)).rejects.toThrow("differs from its verified bundle");
	});
});
