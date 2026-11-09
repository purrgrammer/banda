/** Opt-in private specimen data. Never bundled or copied into web/dist. The source is a fork's recorded data. */
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

export function activityFixture(path: string | undefined): Plugin {
	return {
		name: "banda:private-activity-specimen",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use("/__specimen/activity", (req, res) => {
				const host = req.headers.host ?? "";
				const origin = req.headers.origin;
				if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (origin && origin !== `http://${host}`)) {
					res.statusCode = 403;
					res.end();
					return;
				}
				res.setHeader("cache-control", "no-store");
				res.setHeader("cross-origin-resource-policy", "same-origin");
				res.setHeader("content-type", "application/json");
				if (!path || req.method !== "GET") {
					res.statusCode = 404;
					res.end(JSON.stringify({ error: "No private conversation loaded in this preview." }));
					return;
				}
				void readFile(path).then(
					(data) => res.end(data),
					() => {
						res.statusCode = 404;
						res.end(JSON.stringify({ error: "The private conversation is unavailable." }));
					},
				);
			});
		},
	};
}
