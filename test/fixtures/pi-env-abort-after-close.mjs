// pi-env's `Connection.info(signal)` once the connection is closed and the signal already aborted: the caller handles
// its rejection (`aborted`); pi-env's own `Promise.reject(closed())` is left to Node. Run as its own process, so
// Node's default for an unhandled rejection is what happens. No daemon is started: `close()` comes first.
import { Connection } from "@earendil-works/pi-env";

const connection = new Connection({ command: ["false"] });
connection.close();
const aborted = new AbortController();
aborted.abort();
const handled = await connection.info(aborted.signal).then(
	() => "resolved",
	(error) => `caller got: ${error?.fields?.code ?? error?.message}`,
);
console.log(handled);
// give Node a turn to report what nothing handled
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("survived");
