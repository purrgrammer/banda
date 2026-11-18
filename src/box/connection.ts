/**
 * The box's pi-env connection, which no request reaches once it is closed. pi-env 1.5 answers a request on a closed
 * connection whose signal is already aborted with `aborted` and leaves its own "Connection closed" rejection unhandled,
 * which ends the process (test/pi-env-abort.test.ts). Refused here first, a request after `close()` gets the closed
 * error pi-env 1.4 gave, and pi-env is never asked.
 */
import { Connection, RemoteError } from "@earendil-works/pi-env";

const closedError = () => new RemoteError({ code: "unknown", message: "Connection closed" });

export class BoxConnection extends Connection {
	#closed = false;

	override info(signal?: AbortSignal): ReturnType<Connection["info"]> {
		return this.#closed ? Promise.reject(closedError()) : super.info(signal);
	}

	override request(...args: Parameters<Connection["request"]>): ReturnType<Connection["request"]> {
		return this.#closed ? Promise.reject(closedError()) : super.request(...args);
	}

	override close(): void {
		this.#closed = true;
		super.close();
	}
}
