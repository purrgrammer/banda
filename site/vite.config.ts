// banda.rocks: `npm run build:site` writes dist/site, which Vercel serves; `npm run site:dev` serves it with hot reload.
// The page is plain HTML; its showcase (showcase.tsx) draws the app's own components, so it builds as the app does.
import { createReadStream, existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join, normalize } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const site = import.meta.dirname;
const outDir = join(site, "../dist/site");
const appPublic = join(site, "../web/public");
/** The app's marks its components load by absolute path; the rest of web/public (its worker, manifest) stays the app's. */
const MARKS = ["connections", "providers", "harnesses"] as const;

function appMarks(): Plugin {
	let building = false;
	return {
		name: "banda:app-marks",
		configResolved: (config) => {
			building = config.command === "build";
		},
		configureServer: (server) => {
			server.middlewares.use((req, res, next) => {
				const path = normalize(decodeURIComponent((req.url ?? "").split("?")[0] ?? ""));
				const file = join(appPublic, path);
				if (!MARKS.some((dir) => path.startsWith(`/${dir}/`)) || !file.startsWith(appPublic) || !existsSync(file))
					return next();
				if (file.endsWith(".svg")) res.setHeader("content-type", "image/svg+xml");
				createReadStream(file).pipe(res);
			});
		},
		closeBundle: async () => {
			if (!building) return;
			for (const dir of MARKS) await cp(join(appPublic, dir), join(outDir, dir), { recursive: true });
		},
	};
}

export default defineConfig(({ command }) => ({
	// the page reaches into ../web/public and ../docs: the dev server serves from the repository so they resolve, at /site/
	root: command === "serve" ? join(site, "..") : site,
	plugins: [react(), tailwindcss(), appMarks()],
	resolve: { alias: { "@": join(site, "../web/src") } },
	build: { outDir, emptyOutDir: true, target: "es2022" },
	// the emoji picker's data path, which nothing on the page opens
	define: { __EMOJIBASE__: JSON.stringify("/emojibase") },
}));
