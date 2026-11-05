/**
 * The page as the agent reads it (src/box/snapshot.ts): a sensitive field's value never reaches a snapshot, wherever
 * the page puts it (its value, the text drawn inside it); a key the page shows is a handle, never its value; refs are
 * bound to the snapshot they came from.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type AxNode, parseRef, render, sensitiveField } from "../src/box/snapshot.ts";
import { pbtRuns } from "./pbt.ts";

const word = fc.constantFrom("Email", "Search", "Next", "Name", "Sign in", "Settings", "Profile", "Go", "Save");
/** A value no page would show by chance, so finding it means it leaked. */
const secretValue = fc
	.tuple(
		fc.constantFrom("hunter", "pa ss", "123456", "4111 1111 1111 1111", "émoji-ü"),
		fc.stringMatching(/^[0-9a-f]{6,12}$/),
	)
	.map(([base, tail]) => `${base}${tail}`);
/** A key in one of the shapes pages show them. */
const keyValue = fc
	.tuple(
		fc.constantFrom("sk_live_", "ghp_", "github_pat_", "xoxb-", "AIza", "glpat-", ""),
		fc.stringMatching(/^[A-Za-z0-9]{8}$/),
		fc.integer({ min: 0, max: 9 }),
	)
	.map(([prefix, body, digit]) => `${prefix}${prefix === "" ? "Zq" : ""}${body}${digit}Xy${body}Kp${digit}${body}`);

type Spec =
	| { kind: "field"; name: string; secret?: string; value?: string }
	| { kind: "button" | "link" | "heading"; name: string }
	| { kind: "text"; text: string; key?: string };

const spec: fc.Arbitrary<Spec> = fc.oneof(
	fc.record({ kind: fc.constant("field" as const), name: word, secret: secretValue }),
	fc.record({ kind: fc.constant("field" as const), name: word, value: word }),
	fc.record({ kind: fc.constantFrom("button" as const, "link" as const, "heading" as const), name: word }),
	fc.record({ kind: fc.constant("text" as const), text: word, key: fc.option(keyValue, { nil: undefined }) }),
);

/** A page of `specs` as Chromium's tree, its sensitive fields, the secrets and the keys on it. */
function page(specs: readonly Spec[]) {
	const nodes: AxNode[] = [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" }, childIds: [] }];
	const sensitive = new Set<number>();
	const secrets: string[] = [];
	const keys: string[] = [];
	let id = 1;
	let dom = 100;
	const add = (node: Omit<AxNode, "nodeId">, parent: string) => {
		const nodeId = String(++id);
		nodes.push({ ...node, nodeId, parentId: parent });
		const holder = nodes.find((n) => n.nodeId === parent) as unknown as { childIds: string[] };
		holder.childIds.push(nodeId);
		return nodeId;
	};
	for (const each of specs) {
		const container = add({ role: { value: "generic" }, name: { value: "" }, childIds: [] }, "1");
		if (each.kind === "field") {
			const backend = ++dom;
			const value = each.secret ?? each.value ?? "";
			const field = add(
				{
					role: { value: "textbox" },
					name: { value: each.name },
					value: { value },
					backendDOMNodeId: backend,
					childIds: [],
				},
				container,
			);
			// the text a field draws its value with, under it
			add({ role: { value: "StaticText" }, name: { value }, backendDOMNodeId: ++dom }, field);
			if (each.secret !== undefined) {
				sensitive.add(backend);
				secrets.push(each.secret);
			}
		} else if (each.kind === "text") {
			const text = each.key === undefined ? each.text : `${each.text}: ${each.key}`;
			add({ role: { value: "StaticText" }, name: { value: text }, backendDOMNodeId: ++dom }, container);
			if (each.key !== undefined) keys.push(each.key);
		} else
			add({ role: { value: each.kind }, name: { value: each.name }, backendDOMNodeId: ++dom, childIds: [] }, container);
	}
	return { nodes, sensitive, secrets, keys };
}

describe("the page as the agent reads it", () => {
	it("property: no sensitive field's value and no key's value is ever in a snapshot", () => {
		fc.assert(
			fc.property(
				fc.array(spec, { minLength: 1, maxLength: 25 }),
				fc.integer({ min: 1, max: 50 }),
				(specs, generation) => {
					const { nodes, sensitive, secrets, keys } = page(specs);
					const url = keys.length > 0 ? `https://example.com/done?token=${keys[0]}` : "https://example.com/";
					const shown = render({ title: "A page", url }, [{ url, nodes }], generation, sensitive);
					for (const secret of secrets) expect(shown.text).not.toContain(secret);
					for (const key of keys) {
						expect(shown.text).not.toContain(key);
						expect([...shown.keys.values()]).toContain(key);
					}
					// each handle names exactly the key it hides, and only the daemon holds the map
					for (const handle of shown.keys.keys()) expect(shown.text).toContain(`[key ${handle}]`);
					// every sensitive field is hidden in screenshots too, and shows as a secret
					for (const node of sensitive) expect(shown.hidden).toContain(node);
					expect(shown.text.split("(a secret: its value is hidden)").length - 1).toBe(secrets.length);
					// refs are this snapshot's
					for (const ref of shown.refs.keys()) expect(parseRef(ref)?.generation).toBe(generation);
				},
			),
			{ numRuns: pbtRuns(200) },
		);
	});

	it("a key keeps its handle while the browser runs", () => {
		const key = "sk_live_Ab12Cd34Ef56Gh78Ij90";
		const { nodes } = page([{ kind: "text", text: "Your key", key }]);
		const first = render({ title: "", url: "https://a.example/" }, [{ url: "", nodes }], 1, new Set());
		const second = render({ title: "", url: "https://a.example/" }, [{ url: "", nodes }], 2, new Set(), first.keys);
		expect(first.text).toContain("[key k1]");
		expect(second.text).toContain("[key k1]");
		expect(second.keys.get("k1")).toBe(key);
	});

	it("a commit hash, a uuid and plain words are no keys", () => {
		const text =
			"commit 3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c, id 123e4567-e89b-12d3-a456-426614174000, Hello World";
		const { nodes } = page([{ kind: "text", text }]);
		const shown = render({ title: "", url: "https://a.example/" }, [{ url: "", nodes }], 1, new Set());
		expect(shown.keys.size).toBe(0);
		expect(shown.text).toContain("3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c");
	});

	it("knows a secret field by what it is", () => {
		expect(sensitiveField("INPUT", { type: "password" })).toBe(true);
		expect(sensitiveField("INPUT", { type: "text", autocomplete: "one-time-code" })).toBe(true);
		expect(sensitiveField("INPUT", { autocomplete: "cc-number" })).toBe(true);
		expect(sensitiveField("INPUT", { name: "card_number" })).toBe(true);
		expect(sensitiveField("INPUT", { id: "otp" })).toBe(true);
		expect(sensitiveField("INPUT", { "aria-label": "API key" })).toBe(true);
		expect(sensitiveField("INPUT", { type: "text", name: "email" })).toBe(false);
		expect(sensitiveField("INPUT", { type: "search", placeholder: "Search" })).toBe(false);
	});

	it("a ref names its snapshot", () => {
		expect(parseRef("s12e3")).toEqual({ generation: 12 });
		expect(parseRef("e3")).toBeUndefined();
	});
});
