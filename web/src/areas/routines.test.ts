/**
 * An action on a routine names it twice, in the path and in the body (`id`): that is how the daemon tells this app
 * from one built when a routine's id was its name alone. Against a daemon older than this app, whose views carry no
 * id, the app refuses the action itself, with what to do, and sends nothing: never `/routines/undefined/...`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function loaded() {
	vi.resetModules();
	const sent: { path: string; init: RequestInit | undefined }[] = [];
	vi.doMock("../lib/transport.ts", () => ({
		pickTransport: () => ({
			identified: false,
			request: async (path: string, init?: RequestInit) => {
				sent.push({ path, init });
				return new Response(JSON.stringify({ routines: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			stream: async () => new Response(null, { status: 200 }),
		}),
	}));
	vi.stubGlobal("location", { hash: "#token=t", pathname: "/", search: "" });
	vi.stubGlobal("history", { replaceState: () => {} });
	vi.stubGlobal("addEventListener", () => {});
	const routines = await import("./routines.ts");
	const api = await import("../lib/api.ts");
	return { ...routines, ...api, sent };
}

afterEach(() => {
	vi.doUnmock("../lib/transport.ts");
	vi.unstubAllGlobals();
});

describe("an action on a routine", () => {
	it("names the routine in its body as in its path, whatever the action", async () => {
		const { actOnRoutine, sent } = await loaded();
		await actOnRoutine("curro/tea", { action: "accept", sha: "a".repeat(64), when: "every 2h" });
		await actOnRoutine("tea", { action: "decline" });
		await actOnRoutine("tea", { action: "run", key: "click-1" });
		expect(sent.map((each) => [each.path, each.init?.method, JSON.parse(String(each.init?.body))])).toEqual([
			["/api/routines/curro/tea/accept", "POST", { sha: "a".repeat(64), when: "every 2h", id: "curro/tea" }],
			["/api/routines/tea/decline", "POST", { id: "tea" }],
			["/api/routines/tea/run", "POST", { key: "click-1", id: "tea" }],
		]);
	});

	it("a view with no id, from a daemon older than this app: refused here with what to do, nothing sent", async () => {
		const { actOnRoutine, Refused, sent } = await loaded();
		for (const id of [undefined, "", "Tea", "a/b/c"]) {
			const failed = await actOnRoutine(id as never, { action: "decline" }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failed, String(id)).toBeInstanceOf(Refused);
			expect((failed as Error).message).toMatch(/banda on this computer is older than this app.*update banda/);
		}
		expect(sent).toEqual([]);
	});
});
