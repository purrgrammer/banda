/**
 * What the app is told about the box when it does not come up: Docker missing, stopped, out of reach or too old, in
 * plain words; and that it is being built, the first run.
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BoxState, openBox } from "../src/box/box.ts";
import { DOCKER_MIN, dockerReady, dockerTrouble, engineTooOld } from "../src/box/container.ts";

describe("Docker's trouble, in plain words", () => {
	it("names a missing Docker, a stopped one and one out of this user's reach", () => {
		expect(dockerTrouble({ code: "ENOENT" }, "")).toMatch(/^Docker isn't installed/);
		expect(
			dockerTrouble(
				{ code: 1 },
				"Cannot connect to the Docker daemon at unix:///Users/x/.docker/run/docker.sock. Is the docker daemon running?",
			),
		).toMatch(/^Docker isn't running: start Docker Desktop/);
		expect(
			dockerTrouble(
				{ code: 1 },
				'error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.45/version": open //./pipe/docker_engine: The system cannot find the file specified.',
			),
		).toMatch(/^Docker isn't running/);
		expect(
			dockerTrouble(
				{ code: 1 },
				"permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
			),
		).toMatch(/^banda can't use Docker/);
		expect(dockerTrouble({ code: 1 }, "Error response from daemon: No such container: x")).toBeUndefined();
	});

	it("says the oldest engine the box runs on", () => {
		expect(engineTooOld(`${DOCKER_MIN}.0.0`)).toBeUndefined();
		expect(engineTooOld("27.3.1")).toBeUndefined();
		expect(engineTooOld("24.0.7")).toBe(
			`Docker is too old: the computer needs Docker Engine ${DOCKER_MIN} or later, and this one is 24.0.7. Update Docker, and it starts by itself.`,
		);
		expect(engineTooOld("")).toMatch(/this one is unknown/);
	});
});

describe("dockerReady, against a docker that answers so", () => {
	const path = process.env.PATH;
	afterEach(() => {
		process.env.PATH = path;
	});
	/** A `docker` on the path that prints `stdout` and `stderr` and exits with `code`. */
	async function fakeDocker(stdout: string, stderr: string, code: number) {
		const bin = await mkdtemp(join(tmpdir(), "banda-fake-docker-"));
		const script = join(bin, "docker");
		await writeFile(script, `#!/bin/sh\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`);
		await chmod(script, 0o755);
		process.env.PATH = `${bin}:${path}`;
	}

	it("is stopped", async () => {
		await fakeDocker(
			"",
			"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
			1,
		);
		await expect(dockerReady()).rejects.toThrow(/^Docker isn't running/);
	});

	it("is too old", async () => {
		await fakeDocker("24.0.7", "", 0);
		await expect(dockerReady()).rejects.toThrow(/needs Docker Engine 25 or later, and this one is 24\.0\.7/);
	});

	it("is new enough", async () => {
		await fakeDocker("27.3.1", "", 0);
		await expect(dockerReady()).resolves.toBeUndefined();
	});
});

describe("the box's state", () => {
	it("says it is built while it is, and why it is off when it fails", async () => {
		const seen: BoxState[] = [];
		let fail: (error: Error) => void = () => {};
		const box = openBox(
			{
				workspace: "/workspace",
				attachments: "/work/attachments",
				command: ["true"],
				ensure: (building) => {
					building?.();
					return new Promise((_, reject) => {
						fail = reject;
					});
				},
			},
			() => {},
		);
		box.watch(() => seen.push(box.state()));
		const up = box.ensure().catch(() => undefined);
		expect(box.state()).toEqual({ state: "building" });
		fail(
			new Error(
				"Docker isn't running: start Docker Desktop (or the Docker service), and the computer starts by itself.",
			),
		);
		await up;
		expect(box.state()).toEqual({
			state: "offline",
			why: "Docker isn't running: start Docker Desktop (or the Docker service), and the computer starts by itself.",
		});
		expect(seen.map((s) => s.state)).toEqual(["building", "offline"]);
		box.close();
	});
});
