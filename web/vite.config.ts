// The web UI's build: `npm run build:web` writes web/dist, which the daemon serves. `npm run web:dev` serves it with
// hot reload and passes the API through to a daemon on BANDA_PORT (default 7787).
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { FRAME_POLICY } from "../src/server/policy.ts";
import { activityFixture } from "./scripts/activity-fixture.ts";

const daemon = `http://127.0.0.1:${process.env.BANDA_PORT ?? "7787"}`;

/** Stamps the service worker's cache name with the build's id (a hash of its files' names), so each build caches anew. */
function stampWorker(): Plugin {
	let id = "dev";
	let outDir = "";
	return {
		name: "banda:stamp-worker",
		apply: "build",
		configResolved: (config) => {
			outDir = join(config.root, config.build.outDir);
		},
		generateBundle: (_options, bundle) => {
			id = createHash("sha256").update(Object.keys(bundle).sort().join("\n")).digest("hex").slice(0, 12);
		},
		closeBundle: async () => {
			const path = join(outDir, "sw.js");
			await writeFile(path, (await readFile(path, "utf8")).replaceAll("__BUILD__", id));
		},
	};
}

/** The files of emojibase-data's English locale the emoji picker reads. */
export const EMOJIBASE_FILES = ["data.json", "messages.json"] as const;

/** The pinned emojibase-data: its version and its English locale's directory. */
export function emojibase(): { readonly version: string; readonly dir: string } {
	const manifest = createRequire(import.meta.url).resolve("emojibase-data/package.json");
	const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
	return { version, dir: join(dirname(manifest), "en") };
}

/**
 * Vendors the emoji picker's data (DESIGN.md "Everything the face needs ships with the app"): the build copies
 * emojibase-data's English files to `<outDir>/emojibase/<version>/en/`, the dev server serves the same path from
 * node_modules, and `__EMOJIBASE__` is that path, which the picker fetches from (frimousse falls back to a CDN
 * without it). The version is in the path, so a bump busts every cache, the service worker's included.
 */
export function vendorEmojibase(): Plugin {
	const { version, dir } = emojibase();
	const base = `/emojibase/${version}`;
	let outDir = "";
	return {
		name: "banda:vendor-emojibase",
		config: () => ({ define: { __EMOJIBASE__: JSON.stringify(base) } }),
		configResolved: (config) => {
			// the dev server closes its bundle too: only a build writes the files
			if (config.command === "build") outDir = join(config.root, config.build.outDir);
		},
		configureServer: (server) => {
			server.middlewares.use(`${base}/en`, (req, res, next) => {
				const name = (req.url ?? "").split("?")[0]?.replace(/^\//, "") ?? "";
				if (!(EMOJIBASE_FILES as readonly string[]).includes(name)) return next();
				res.setHeader("content-type", "application/json");
				createReadStream(join(dir, name)).pipe(res);
			});
		},
		closeBundle: async () => {
			if (outDir === "") return;
			const to = join(outDir, "emojibase", version, "en");
			await mkdir(to, { recursive: true });
			for (const name of EMOJIBASE_FILES) await copyFile(join(dir, name), join(to, name));
		},
	};
}

export default defineConfig({
	root: import.meta.dirname,
	plugins: [
		react(),
		tailwindcss(),
		stampWorker(),
		vendorEmojibase(),
		activityFixture(process.env.BANDA_ACTIVITY_FIXTURE),
	],
	// shadcn's components import each other through `@/`
	resolve: { alias: { "@": `${import.meta.dirname}/src` } },
	build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
	server: {
		port: 5173,
		// the daemon's frame policy: a page's frame stays where it is here too (the rest of its policy would refuse the
		// dev server's own inline script and socket)
		headers: { "content-security-policy": FRAME_POLICY },
		// The daemon checks Host and Origin, so the proxy speaks as the daemon's own origin.
		proxy: {
			"/api": { target: daemon, changeOrigin: true, headers: { origin: daemon } },
			// The daemon derives these from the first active agent's accepted face, including in dev mode.
			"^/(?:icon(?:-maskable)?\\.svg|icon-(?:192|512|maskable-512)\\.png|apple-touch-icon\\.png|manifest\\.webmanifest)$":
				{
					target: daemon,
					changeOrigin: true,
				},
		},
	},
});
