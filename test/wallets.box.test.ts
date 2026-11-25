/**
 * The wallets from inside a real box (H-061, H-062; docs/wallets.md "Architecture"): a daemon on the box
 * `BANDA_TEST_BOX` names (fixtures/real-box.ts) holds a wallet made and revealed through `banda wallet create`, its key
 * kept by the signer child in a file keystore outside the home; then, as a command in the box could, nothing reaches
 * the daemon's wallet routes at any address the box might take for the host, no signer runs where the box sees it, the
 * keystore and the host's keychain are not there, and no wallet file, environment variable or credential is mounted or
 * readable. The proxy's refusal of loopback and private destinations is egress.box.test.ts's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { walletCommand } from "../src/cli/wallet.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { markTestHome } from "../src/wallet/home-id.ts";
import { boxSuite, PROCESSES, realBox } from "./fixtures/real-box.ts";
import { FauxChain } from "./helpers/faux-chain.ts";
import { echoModels, until } from "./helpers.ts";

/**
 * Tries the daemon's wallet route at every address a box could take for the host, without the proxy, printing one
 * line per address with curl's exit code and whatever answered. Takes the port and the owner's token as arguments, so
 * no file holds it. A control first: a server the probe starts on the box's own loopback answers it, so a refusal
 * below is a refusal and not a probe that never ran.
 */
const PROBE = `
port="$1"; token="$2"
printf 'HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\n\\r\\nok' > /tmp/wallet-control.http
socat -U TCP4-LISTEN:8766,bind=127.0.0.1,reuseaddr,fork OPEN:/tmp/wallet-control.http,rdonly >/dev/null 2>&1 &
control=$!
# the control is up once it answers: waited on, at most five seconds, never a fixed sleep
answer=""
for i in $(seq 50); do
	answer=$(curl -s -m 1 --noproxy '*' http://127.0.0.1:8766/ 2>/dev/null) && [ "$answer" = ok ] && break
	sleep 0.1
done
echo "control: $answer"
kill $control 2>/dev/null; rm -f /tmp/wallet-control.http
hosts="127.0.0.1 localhost host.docker.internal gateway.docker.internal host.containers.internal 10.0.2.2 192.168.65.254 172.17.0.1"
gw=$(awk '$2=="00000000" { print $3; exit }' /proc/net/route 2>/dev/null)
if [ -n "$gw" ]; then
	hosts="$hosts $((16#\${gw:6:2})).$((16#\${gw:4:2})).$((16#\${gw:2:2})).$((16#\${gw:0:2}))"
fi
for host in $hosts; do
	answer=$(curl -s -m 4 --noproxy '*' -H "authorization: Bearer $token" "http://$host:$port/api/wallets" 2>/dev/null)
	echo "$host: $?: $answer"
done
`;

boxSuite(`the wallets from inside the box (${realBox.kind})`, { timeout: 300_000 }, () => {
	const logs: string[] = [];
	let home: string;
	let keys: string;
	let keystore: string;
	let daemon: Daemon;
	let token: string;
	let address: string;
	let key: string;
	let chain: Server | undefined;

	beforeAll(async () => {
		keys = mkdtempSync(join(tmpdir(), "banda-wallets-box-keys-"));
		keystore = join(keys, "keychain.json");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keystore);
		home = mkdtempSync(join(tmpdir(), "banda-wallets-box-test-"));
		await markTestHome(home);
		// the wallet's chain is the test's own, on this machine's loopback at a port the system assigns: no request of the
		// daemon's reaches a public RPC
		const faux = new FauxChain(84532);
		chain = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", async () => {
				const answer = await faux.fetch("http://chain/", { method: "POST", body });
				response.writeHead(answer.status, { "content-type": "application/json" });
				response.end(await answer.text());
			});
		});
		await new Promise<void>((resolve) => chain?.listen(0, "127.0.0.1", resolve));
		const rpc = `http://127.0.0.1:${(chain.address() as AddressInfo).port}/`;
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, wallets: { rpc: { "base-sepolia": rpc } } }),
		);
		const web = join(home, "web");
		mkdirSync(web);
		writeFileSync(join(web, "index.html"), "<!doctype html><title>banda</title>");
		daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: (line) => logs.push(line),
			box: realBox.setup(home),
			web,
		});
		token = (await readDaemonFile(home))?.token as string;
		// bounded: a box that cannot come up says why in the daemon's log, which this failure then carries
		const deadline = Date.now() + 10 * 60_000;
		await until(async () => {
			if (await realBox.running(home, "box")) return true;
			if (Date.now() > deadline)
				throw new Error(
					`the box did not come up:\n${logs
						.filter((line) => line.startsWith("box:"))
						.slice(-20)
						.join("\n")}`,
				);
			return false;
		}, 500);
		const printed: string[] = [];
		expect(
			await walletCommand(home, "create", ["Box test"], { network: "base-sepolia", terminal: true }, (text) =>
				printed.push(text),
			),
		).toBe(0);
		key = /\b0x([0-9a-f]{64})\b/.exec(printed.join("\n"))?.[1] as string;
		// the print gives the address short (H-005): the key opens the whole one
		address = privateKeyToAddress(`0x${key}`);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	}, 20 * 60_000);

	afterAll(async () => {
		await daemon?.close();
		await new Promise((resolve) => (chain === undefined ? resolve(undefined) : chain.close(resolve)));
		vi.unstubAllEnvs();
		if (home !== undefined) {
			await realBox.remove(home);
			rmSync(home, { recursive: true, force: true });
		}
		if (keys !== undefined) rmSync(keys, { recursive: true, force: true });
	});

	const box = (command: string) => realBox.exec(home, "box", command);

	it("reaches the daemon's wallet routes at no address the box could take for the host", async () => {
		// the probe's tools are there: an empty answer below means refused, never not tried
		expect(
			await box("command -v bash >/dev/null && command -v curl >/dev/null && command -v socat >/dev/null && echo yes"),
		).toBe("yes");
		await box(`cat > /tmp/wallet-probe.sh <<'PROBE'\n${PROBE}\nPROBE`);
		const [control, ...answers] = (
			await box(`bash /tmp/wallet-probe.sh ${daemon.port} ${token}; rm -f /tmp/wallet-probe.sh`)
		)
			.split("\n")
			.filter((line) => line !== "");
		expect(control).toBe("control: ok");
		expect(answers.length).toBeGreaterThanOrEqual(8);
		for (const answer of answers) {
			// curl ran and was refused: could not resolve (6), could not connect (7), timed out (28), or got nothing
			// (52, 56); an answer it got (0) is checked below for what it must not hold
			expect(answer, answer).toMatch(/^[^:]+: (0|6|7|28|52|56): /);
			expect(answer.toLowerCase(), answer).not.toContain(address.toLowerCase());
			expect(answer, answer).not.toContain("missing or wrong token");
			expect(answer, answer).not.toContain('"wallets"');
		}
	});

	it("runs no signer the box can see, and holds neither the keystore nor the host's keychain", async () => {
		const processes = await box(PROCESSES);
		expect(processes).not.toMatch(/signer\.(ts|js)/);
		expect(processes).not.toContain(home);
		const paths = [keys, keystore, home, "/Users", "/Library/Keychains", "/run/dbus/system_bus_socket"];
		const present = await box(
			`${paths.map((path) => `test -e '${path}' && echo '${path}'`).join("; ")}; ls -d /run/user/*/bus 2>/dev/null; true`,
		);
		expect(present).toBe("");
	});

	it("mounts and passes no wallet file, environment variable or credential", async () => {
		const env = `${await box("env")}\n${await box("tr '\\0' '\\n' < /proc/1/environ 2>/dev/null || true")}`;
		for (const line of env.split("\n")) {
			const name = line.split("=")[0] ?? "";
			expect(name, line).not.toMatch(/^BANDA_|KEYSTORE|KEYCHAIN|WALLET|DBUS/i);
		}
		expect(env).not.toContain(token);
		expect(env).not.toContain(key);
		const mounts = await box("cat /proc/mounts");
		for (const path of [home, keys, ".banda", "keychain", "Keychains", "durable.db"])
			expect(mounts).not.toContain(path);
		// what a command could read: the key, in any case, and the owner's token are in no file of the box
		const found = await box(
			`grep -rIl -i -e '${key}' -e '${token}' /workspace /work /tools /tmp /etc /root /home /run /var /opt /srv 2>/dev/null || true`,
		);
		expect(found).toBe("");
	});
});
