// banda's Android signing key: makes it once and sets the release workflow's four secrets from it.
//
//   node scripts/android-key.ts [--repo owner/name] [--dir path] [--dry-run]
//
// The keystore and its password stay outside the checkout, in --dir (default ~/.banda-android-key), readable by you
// alone. Back both up: an APK signed with another key cannot install over the one a phone has. Run it again to set
// the secrets from the key already there; it never replaces an existing key. Passwords reach keytool and gh through
// the environment and stdin, never argv.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		repo: { type: "string", default: "purrgrammer/banda" },
		dir: { type: "string", default: join(homedir(), ".banda-android-key") },
		"dry-run": { type: "boolean", default: false },
	},
});
const dir = values.dir as string;
const repo = values.repo as string;
const dryRun = values["dry-run"] as boolean;
const alias = "banda";
const keystore = join(dir, "banda.jks");
const passwordFile = join(dir, "password");

function need(tool: string, versionArg: string): void {
	try {
		execFileSync(tool, [versionArg], { stdio: "ignore" });
	} catch {
		throw new Error(`${tool} is not on PATH`);
	}
}

need("keytool", "-help");
if (!dryRun) need("gh", "--version");

let password: string;
if (existsSync(keystore)) {
	if (!existsSync(passwordFile)) throw new Error(`${keystore} exists but ${passwordFile} does not`);
	password = readFileSync(passwordFile, "utf8").trim();
	console.log(`using the key already at ${keystore}`);
} else {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	// PKCS12 keeps one password for the store and the key
	password = randomBytes(24).toString("base64url");
	writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
	execFileSync(
		"keytool",
		[
			"-genkeypair",
			"-keystore",
			keystore,
			"-storetype",
			"PKCS12",
			"-alias",
			alias,
			"-keyalg",
			"RSA",
			"-keysize",
			"4096",
			"-validity",
			"10000",
			"-dname",
			"CN=banda",
			"-storepass:env",
			"BANDA_KEY_PASSWORD",
			"-keypass:env",
			"BANDA_KEY_PASSWORD",
		],
		{ env: { ...process.env, BANDA_KEY_PASSWORD: password }, stdio: ["ignore", "ignore", "inherit"] },
	);
	chmodSync(keystore, 0o600);
	console.log(`made a new key at ${keystore}`);
}

const listing = execFileSync(
	"keytool",
	["-list", "-v", "-keystore", keystore, "-alias", alias, "-storepass:env", "BANDA_KEY_PASSWORD"],
	{ env: { ...process.env, BANDA_KEY_PASSWORD: password }, encoding: "utf8" },
);
const fingerprint = listing.match(/SHA256:\s*(\S+)/)?.[1] ?? "(not found)";
console.log(`certificate SHA-256: ${fingerprint}`);

const secrets: Record<string, string> = {
	BANDA_ANDROID_KEYSTORE_BASE64: readFileSync(keystore).toString("base64"),
	BANDA_ANDROID_KEYSTORE_PASSWORD: password,
	BANDA_ANDROID_KEY_ALIAS: alias,
	BANDA_ANDROID_KEY_PASSWORD: password,
};
for (const [name, value] of Object.entries(secrets)) {
	if (dryRun) {
		console.log(`would set ${name} on ${repo}`);
		continue;
	}
	execFileSync("gh", ["secret", "set", name, "-R", repo], { input: value, stdio: ["pipe", "ignore", "inherit"] });
	console.log(`set ${name} on ${repo}`);
}

console.log(`\nback up ${dir} (the keystore and its password) somewhere safe: losing it means phones cannot update`);
