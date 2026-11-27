// Spike SEC-K2: an item planted by another binary (/usr/bin/security, "-A" = any app) under the name the daemon would use.
// Does the daemon's module read it silently (adoption), and does setPassword overwrite an existing item?
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const require = createRequire(process.env.DEPS + "/package.json");
const { Entry } = require("@napi-rs/keyring");
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const service = "banda-spike-" + randomBytes(6).toString("hex");
const planted = randomBytes(32).toString("hex");
execFileSync("/usr/bin/security", ["-i"], { input: `add-generic-password -A -s ${service} -a spike -w ${planted}\n` });
const e = new Entry(service, "spike");
const read1 = e.getPassword();
const mine = randomBytes(32).toString("hex");
let setResult = "ok";
try { e.setPassword(mine); } catch (err) { setResult = "threw: " + err.message; }
const read2 = e.getPassword();
const out = { service, plantedHash: h(planted), read1Hash: read1 && h(read1), adoptedPlanted: read1 === planted, setResult, read2IsMine: read2 === mine, read2IsPlanted: read2 === planted };
console.log(JSON.stringify(out));
let deleted = 0; while (true) { try { if (!e.deletePassword()) break; deleted++; } catch (err) { console.log("delete error", err.message); break; } if (deleted > 5) break; }
console.log(JSON.stringify({ deleted, remaining: e.getPassword() !== null }));
