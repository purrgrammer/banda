// Spike SEC-K1 (reader): a different script, different directory, separate process, same node binary.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(process.env.DEPS + "/package.json");
const { Entry } = require("@napi-rs/keyring");
const [service, action] = process.argv.slice(2);
const e = new Entry(service, "spike");
if (action === "delete") { console.log(JSON.stringify({ deleted: e.deletePassword() })); process.exit(0); }
const t0 = Date.now();
const v = e.getPassword();
console.log(JSON.stringify({ found: v !== null, sha256: v === null ? null : createHash("sha256").update(v).digest("hex"), ms: Date.now() - t0 }));
