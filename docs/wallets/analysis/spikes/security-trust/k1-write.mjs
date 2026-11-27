// Spike SEC-K1 (writer): store a dummy, never-funded random 32-byte hex value under banda-spike-<rand>.
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
const require = createRequire(process.env.DEPS + "/package.json");
const { Entry } = require("@napi-rs/keyring");
const service = "banda-spike-" + randomBytes(6).toString("hex");
const secret = randomBytes(32).toString("hex");
new Entry(service, "spike").setPassword(secret);
console.log(JSON.stringify({ service, sha256: createHash("sha256").update(secret).digest("hex") }));
