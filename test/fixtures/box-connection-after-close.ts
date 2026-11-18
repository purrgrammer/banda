// The same request as pi-env-abort-after-close.mjs, through the box's connection: refused before pi-env is asked.
import { BoxConnection } from "../../src/box/connection.ts";

const connection = new BoxConnection({ command: ["false"] });
connection.close();
const aborted = new AbortController();
aborted.abort();
for (const asked of [
	() => connection.info(aborted.signal),
	() => connection.request("stat", {}, { signal: aborted.signal }),
])
	console.log(
		await asked().then(
			() => "resolved",
			(error: { fields?: { code?: string; message?: string } }) =>
				`caller got: ${error.fields?.code} ${error.fields?.message}`,
		),
	);
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("survived");
