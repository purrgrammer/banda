/**
 * Write the GitHub connection banda ships (`shipped/connections/github.json`) from a checkout of github-mcp-server:
 * which tools only read (their `ReadOnlyHint`), and the scope each needs, from the README's "OAuth Challenge Scopes".
 * A tool's first scope is the one it always needs; the others depend on what it is called on (an org, an enterprise,
 * a workflow file) and are left to the server's challenge at call time. A scope also counts when one that covers it was
 * given (`repo` covers `security_events`).
 *
 * And GitHub's objects, as `scripts/github-objects.ts` declares them: what the app draws as cards, read with the reads
 * named above.
 *
 * Usage: node scripts/shipped-github.ts <github-mcp-server checkout>
 * Reads files only: nothing of the checkout is built or run.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_OBJECTS } from "./github-objects.ts";

const [checkout] = process.argv.slice(2);
if (checkout === undefined) throw new Error("usage: node scripts/shipped-github.ts <github-mcp-server checkout>");

/** Scopes that a broader one covers, as GitHub documents them. */
const COVERED_BY: { readonly [scope: string]: readonly string[] } = {
	public_repo: ["repo"],
	security_events: ["repo"],
	"repo:status": ["repo"],
	"read:org": ["write:org", "admin:org"],
	"write:org": ["admin:org"],
	"read:project": ["project"],
	"read:packages": ["write:packages"],
	"read:enterprise": ["admin:enterprise"],
};

const readme = readFileSync(join(checkout, "README.md"), "utf8");
const tools = readme.slice(
	readme.indexOf("<!-- START AUTOMATED TOOLS -->"),
	readme.indexOf("<!-- END AUTOMATED TOOLS -->"),
);
const scopes = new Map<string, string[]>();
let current: string | undefined;
for (const line of tools.split("\n")) {
	const named = /^- \*\*([a-z0-9_]+)\*\* - /.exec(line);
	if (named !== null) {
		current = named[1] as string;
		scopes.set(current, []);
		continue;
	}
	const challenge = /^\s+- \*\*OAuth Challenge Scopes\*\*: (.*)$/.exec(line);
	if (challenge !== null && current !== undefined)
		scopes.set(
			current,
			[...(challenge[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string),
		);
}

const readOnly = new Map<string, boolean>();
const source = join(checkout, "pkg", "github");
for (const file of readdirSync(source).filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"))) {
	const text = readFileSync(join(source, file), "utf8");
	for (const match of text.matchAll(/Name:\s+"([a-z0-9_]+)"/g)) {
		const name = match[1] as string;
		if (!scopes.has(name) || readOnly.has(name)) continue;
		const rest = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + 4000);
		const next = /Name:\s+"[a-z0-9_]+"/.exec(rest);
		const hint = /ReadOnlyHint:\s+(true|false)/.exec(next === null ? rest : rest.slice(0, next.index));
		if (hint !== null) readOnly.set(name, hint[1] === "true");
	}
}

const names = [...scopes.keys()].sort();
const reads = names.filter((name) => readOnly.get(name) === true);
const needs = Object.fromEntries(
	names.flatMap((name) => {
		const base = scopes.get(name)?.[0];
		return base === undefined ? [] : [[name, [base, ...(COVERED_BY[base] ?? [])]]];
	}),
);

const scopeChoice = (label: string, ...scopes: readonly string[]) => ({ label, scopes });
const definition = {
	service: "GitHub",
	about: "Pull requests, issues, checks",
	url: "https://api.githubcopilot.com/mcp/",
	auth: "oauth",
	client: "Ov23liQCTpiVBm3fuBgj",
	scopes: ["repo", "read:org"],
	access: {
		choices: [
			scopeChoice("Repositories, including private repositories", "repo"),
			scopeChoice("Organization and team information", "read:org"),
			scopeChoice("Read and manage notifications", "notifications"),
			scopeChoice("Read and manage gists", "gist"),
			scopeChoice("Repository security alerts", "security_events"),
			scopeChoice("Read and manage projects", "project"),
			scopeChoice("Read projects", "read:project"),
			scopeChoice("Administer organizations", "admin:org"),
			scopeChoice("Manage organization membership and teams", "write:org"),
			scopeChoice("Delete repositories", "delete_repo"),
		],
		note: "Changing access signs in again. Actions that change GitHub still ask you to approve them.",
	},
	account: "get_me.login",
	reads,
	needs,
	objects: GITHUB_OBJECTS,
};
writeFileSync(
	new URL("../shipped/connections/github.json", import.meta.url),
	`${JSON.stringify(definition, null, "\t")}\n`,
);
console.log(`${names.length} tools, ${reads.length} reads, ${Object.keys(needs).length} with a scope they need`);
