import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { guardedProxy, type ProxyTransport } from "../src/box/guarded-proxy.ts";
import type { HeldRequest } from "../src/core/egress.ts";
import { context } from "../src/core/store.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome } from "./helpers.ts";

it("gives separate computers separate filesystem namespaces while views of one computer share one", async () => {
	const first = openBox({ ...hostBox(await tempHome()), kind: "microvm" }, () => {});
	const second = openBox({ ...hostBox(await tempHome()), kind: "microvm" }, () => {});
	try {
		expect(first.env().id).toBe(first.env("/workspace/other").id);
		expect(first.env().id).not.toBe(second.env().id);
	} finally {
		await first.close();
		await second.close();
	}
});

it("reports failed egress preparation as offline and not sent, preserving uncertainty after execution starts", async () => {
	const home = await tempHome();
	const setup = hostBox(home);
	let available = false;
	let attempts = 0;
	let interrupted = false;
	const transport: ProxyTransport = {
		exec: async () => {
			attempts++;
			if (interrupted) throw new Error("connection lost after start");
			return JSON.stringify({ status: 201, reason: "Created", headers: [], body: "" });
		},
		running: async () => true,
		halt: async () => {},
	};
	const proxy = guardedProxy({ home, endpoint: "127.0.0.1:80", transport });
	const box = openBox(
		{
			...setup,
			kind: "microvm",
			egress: proxy.egress,
			ensure: async () => {
				if (!available) throw new Error("computer offline");
				await setup.ensure();
			},
		},
		() => {},
	);
	const request: HeldRequest = {
		ticket: "t1",
		chat: 7,
		at: 1,
		method: "POST",
		scheme: "https",
		host: "example.com",
		port: 443,
		path: "/send",
		headers: [],
		body: "",
	};
	try {
		const egress = box.egress;
		if (egress === undefined) throw new Error("missing guarded egress");
		expect(await egress.replay(request, context)).toEqual({ failed: "computer offline", reached: false });
		expect(attempts).toBe(0);
		expect(box.state()).toMatchObject({ state: "offline" });
		available = true;
		expect(await egress.replay(request, context)).toMatchObject({ status: 201 });
		expect(attempts).toBe(1);
		expect(box.state()).toEqual({ state: "up" });
		interrupted = true;
		await expect(egress.replay(request, context)).rejects.toThrow("connection lost after start");
		expect(attempts).toBe(2);
	} finally {
		await box.close();
	}
});

it("repairs native dependencies before using an existing command connection and never replays a command", async () => {
	const home = await tempHome();
	const setup = hostBox(home);
	let available = true;
	let preparations = 0;
	const box = openBox(
		{
			...setup,
			kind: "microvm",
			ensure: async () => {
				preparations++;
				if (!available) throw new Error("network guard unavailable");
				await setup.ensure();
			},
		},
		() => {},
	);
	try {
		const env = box.env();
		expect(await env.exec("printf first >> effects", undefined, context)).toMatchObject({
			ok: true,
			value: { exitCode: 0 },
		});
		const prepared = preparations;
		available = false;
		await expect(env.exec("printf missed >> effects", undefined, context)).rejects.toThrow("network guard unavailable");
		expect(box.state()).toMatchObject({ state: "offline" });
		expect(await readFile(join(home, "workspace/effects"), "utf8")).toBe("first");
		available = true;
		expect(await env.exec("printf failed >> effects; exit 3", undefined, context)).toMatchObject({
			ok: true,
			value: { exitCode: 3 },
		});
		expect(await readFile(join(home, "workspace/effects"), "utf8")).toBe("firstfailed");
		expect(preparations).toBe(prepared + 2);
		expect(box.state()).toEqual({ state: "up" });
	} finally {
		await box.close();
	}
});

it("starts no waiting command when the computer closes during recovery", async () => {
	const home = await tempHome();
	const setup = hostBox(home);
	let repairing = false;
	let acquired = () => {};
	const acquiring = new Promise<void>((resolve) => {
		acquired = resolve;
	});
	let release = () => {};
	const recovery = new Promise<void>((resolve) => {
		release = resolve;
	});
	const box = openBox(
		{
			...setup,
			kind: "microvm",
			ensure: async () => {
				if (repairing) {
					acquired();
					await recovery;
				}
				await setup.ensure();
			},
		},
		() => {},
	);
	try {
		const env = box.env();
		expect(await env.exec("printf kept > effects", undefined, context)).toMatchObject({
			ok: true,
			value: { exitCode: 0 },
		});
		repairing = true;
		const waiting = Promise.allSettled([
			env.exec("printf first >> effects", undefined, context),
			env.exec("printf second >> effects", undefined, context),
		]);
		try {
			await acquiring;
			expect(await readFile(join(home, "workspace/effects"), "utf8")).toBe("kept");
			const closing = box.close();
			release();
			await closing;
			expect(await waiting).toEqual([
				{ status: "rejected", reason: expect.objectContaining({ message: "The computer is closed" }) },
				{ status: "rejected", reason: expect.objectContaining({ message: "The computer is closed" }) },
			]);
			expect(await readFile(join(home, "workspace/effects"), "utf8")).toBe("kept");
		} finally {
			release();
			await waiting;
		}
	} finally {
		release();
		await box.close();
	}
});
