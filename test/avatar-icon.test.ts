import { readFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { Resvg } from "@resvg/resvg-js";
import { getExample } from "open-bot-avatar";
import { describe, expect, it } from "vitest";
import { type AvatarFace, defaultAvatarFace } from "../src/core/avatar-face.ts";
import { avatarIcon, avatarIconPng, avatarIcons, avatarManifest, ICON_FILES } from "../src/core/avatar-icon.ts";
import type { AgentView } from "../src/server/api.ts";
import { handler, type Routes } from "../src/server/http.ts";

const chosen: AvatarFace = { definition: getExample("mug") ?? defaultAvatarFace().definition, color: "#123456" };
// The route reads only accepted.agent.face/state. Unknown intentionally exercises malformed persisted data too.
const agent = (face: unknown, state = "active"): AgentView =>
	({ name: "private-name", accepted: { agent: { face, state } } }) as AgentView;

async function serving(agents: () => Promise<AgentView[]>, run: (base: string) => Promise<void>) {
	let port = 0;
	const iconFace = async () =>
		(await agents()).find((row) => row.accepted?.agent?.state === "active")?.accepted?.agent?.face;
	const server = createServer(
		handler(
			{
				iconFace,
				agents: () => {
					throw new Error("public icon read pending files");
				},
			} as unknown as Routes,
			() => port,
			"secret",
			"/nonexistent",
		),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	try {
		await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

function expectPng(bytes: Buffer, size: number) {
	expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
	expect(bytes.readUInt32BE(16)).toBe(size);
	expect(bytes.readUInt32BE(20)).toBe(size);
	expect(bytes.length).toBeGreaterThan(500);
}

describe("avatar install icons", () => {
	it("draws only validated geometry and colour, without identity metadata or active/external SVG", () => {
		const face = { ...chosen, definition: { ...chosen.definition, name: "private-shape-name", id: "private-id" } };
		const svg = avatarIcon(face);
		expect(svg).toContain('viewBox="0 0 512 512"');
		expect(svg).toContain("translate(32 32)");
		expect(svg).toContain('width="448"');
		expect(svg).toContain(face.color);
		expect(svg).not.toMatch(/private-|<script|<image|<foreignObject|https?:\/\/(?!www\.w3\.org)/i);
	});

	it("leaves the favicon background transparent while retaining the face", () => {
		for (const face of [defaultAvatarFace(), chosen]) {
			const { pixels } = new Resvg(avatarIcon(face), { font: { loadSystemFonts: false } }).render();
			expect(pixels[3]).toBe(0);
			expect(pixels[(512 * 512 - 1) * 4 + 3]).toBe(0);
			let opaque = 0;
			for (let offset = 3; offset < pixels.length; offset += 4) {
				if (pixels[offset] === 255) opaque++;
			}
			expect(opaque).toBeGreaterThan(1000);
		}
	});

	it("keeps every non-background pixel inside the maskable safe circle, with an opaque full bleed", () => {
		const svg = avatarIcon(chosen, true);
		expect(svg).toContain("translate(112 112)");
		const { pixels } = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
		let colored = 0;
		for (let y = 0; y < 512; y++) {
			for (let x = 0; x < 512; x++) {
				const offset = (y * 512 + x) * 4;
				if (pixels[offset + 3] !== 255) throw new Error("Transparent maskable pixel");
				if (pixels[offset] === 252 && pixels[offset + 1] === 252 && pixels[offset + 2] === 252) continue;
				colored++;
				if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4) throw new Error("Outside safe circle");
			}
		}
		expect(colored).toBeGreaterThan(1000);
	});

	it("rejects malformed candidates before rendering", () => {
		for (const face of [
			{ ...chosen, color: 'red" onload="alert(1)' },
			{ ...chosen, definition: "<svg><script/></svg>" },
			{ ...chosen, definition: { ...chosen.definition, body: { path: "M0 0<script>" } } },
			{ ...chosen, extra: "unaccepted" },
		]) {
			expect(() => avatarIcon(face as AvatarFace)).toThrow("Invalid avatar face");
		}
	});

	it("reuses derived bytes but invalidates on either colour or geometry changes", () => {
		const icons = avatarIcons();
		const first = icons(defaultAvatarFace());
		const firstPng = first.image("/icon-512.png");
		expect(icons(defaultAvatarFace()).image("/icon-512.png")).toBe(firstPng);
		const recolored = icons({ ...defaultAvatarFace(), color: chosen.color });
		expect(recolored.revision).not.toBe(first.revision);
		expect(recolored.image("/icon-512.png").etag).not.toBe(firstPng.etag);
		const reshaped = icons(chosen);
		expect(reshaped.revision).not.toBe(recolored.revision);
	});

	it("ships reproducible default SVG/PNG fallbacks and matching manifest without platform commands", async () => {
		const icons = avatarIcons()(defaultAvatarFace());
		for (const [path, spec] of Object.entries(ICON_FILES)) {
			const disk = await readFile(new URL(`../web/public${path}`, import.meta.url));
			expect(disk).toEqual(icons.image(path as keyof typeof ICON_FILES).bytes);
			if (!spec.svg) expectPng(disk, spec.size);
		}
		const manifest = JSON.parse(await readFile(new URL("../web/public/manifest.webmanifest", import.meta.url), "utf8"));
		expect(manifest).toEqual(JSON.parse(avatarManifest()));
		expect(avatarIconPng(chosen, 180)).not.toEqual(avatarIconPng(defaultAvatarFace(), 180));
	});
});

describe("icon HTTP routes", () => {
	it("serves the default chat bubble before any agent is accepted, including real touch/install PNGs", async () => {
		await serving(
			async () => [],
			async (base) => {
				const icons = avatarIcons()(defaultAvatarFace());
				for (const [path, spec] of Object.entries(ICON_FILES)) {
					const response = await fetch(base + path);
					expect(response.status).toBe(200);
					expect(response.headers.get("content-type")).toBe(spec.svg ? "image/svg+xml" : "image/png");
					const bytes = Buffer.from(await response.arrayBuffer());
					expect(bytes).toEqual(icons.image(path as keyof typeof ICON_FILES).bytes);
					if (!spec.svg) expectPng(bytes, spec.size);
				}
			},
		);
	});

	it("serves only the first active accepted face, not pending candidates or another agent", async () => {
		const pending = { name: "pending", change: { kind: "added", agent: { face: defaultAvatarFace() } } } as AgentView;
		const first = { ...agent(chosen), change: pending.change };
		await serving(
			async () => [agent(defaultAvatarFace(), "archived"), pending, first, agent(defaultAvatarFace())],
			async (base) => {
				const response = await fetch(`${base}/icon.svg`);
				expect(await response.text()).toBe(avatarIcon(chosen));
				expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
				expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
				expect(response.headers.get("x-content-type-options")).toBe("nosniff");
				const png = await fetch(`${base}/apple-touch-icon.png`);
				expect(Buffer.from(await png.arrayBuffer())).toEqual(avatarIconPng(chosen, 180));
			},
		);
	});

	it("uses the default while the only face is still an unaccepted candidate", async () => {
		const candidate = { name: "pending", change: { kind: "added", agent: { face: chosen } } } as AgentView;
		await serving(
			async () => [candidate],
			async (base) => {
				expect(await (await fetch(`${base}/icon.svg`)).text()).toBe(avatarIcon(defaultAvatarFace()));
			},
		);
	});

	it("never renders a malformed face or leaks it in an error", async () => {
		await serving(
			async () => [agent({ ...chosen, color: '<script src="https://evil.test"/>' })],
			async (base) => {
				const response = await fetch(`${base}/icon.svg`);
				expect(response.status).toBe(200);
				expect(await response.text()).toBe(avatarIcon(defaultAvatarFace()));
			},
		);
	});

	it("revalidates bytes and manifest, handles HEAD/304, and invalidates all representations after acceptance", async () => {
		let face = defaultAvatarFace();
		await serving(
			async () => [agent(face)],
			async (base) => {
				const paths = [...Object.keys(ICON_FILES), "/manifest.webmanifest"];
				const old = new Map<string, string>();
				for (const path of paths) {
					const response = await fetch(base + path);
					const etag = response.headers.get("etag") ?? "";
					expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
					expect(response.headers.get("cache-control")).toBe("private, no-cache");
					const body = await response.arrayBuffer();
					old.set(path, etag);
					const head = await fetch(base + path, { method: "HEAD" });
					expect(head.headers.get("etag")).toBe(etag);
					expect(head.headers.get("content-length")).toBe(String(body.byteLength));
					expect(await head.text()).toBe("");
					const cached = await fetch(base + path, { headers: { "if-none-match": `"other", W/${etag}` } });
					expect(cached.status).toBe(304);
					expect(await cached.text()).toBe("");
				}
				face = chosen;
				for (const path of paths) {
					const response = await fetch(`${base}${path}?v=old`, { headers: { "if-none-match": old.get(path) ?? "" } });
					expect(response.status).toBe(200);
					expect(response.headers.get("etag")).not.toBe(old.get(path));
					if (path === "/manifest.webmanifest") {
						const manifest = (await response.json()) as { id: string; icons: { src: string }[] };
						expect(manifest.id).toBe("/");
						expect(manifest.icons).toHaveLength(5);
						for (const icon of manifest.icons) expect(icon.src).toMatch(/\?v=[a-f0-9]{64}$/);
					} else await response.arrayBuffer();
				}
			},
		);
	});

	it("preserves host/origin/API boundaries and refuses writes", async () => {
		await serving(
			async () => [agent(chosen)],
			async (base) => {
				for (const path of ["/icon.svg", "/apple-touch-icon.png", "/manifest.webmanifest"]) {
					for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
						expect((await fetch(base + path, { headers })).status, JSON.stringify(headers)).toBe(403);
					}
					const badHost = await new Promise<number | undefined>((resolve, reject) => {
						get(base + path, { headers: { host: "evil.test" } }, (response) => {
							response.resume();
							resolve(response.statusCode);
						}).on("error", reject);
					});
					expect(badHost).toBe(403);
					expect((await fetch(base + path, { method: "POST" })).status).toBe(405);
				}
				expect((await fetch(`${base}/api/agents`)).status).toBe(401);
			},
		);
	});
});
