import { launchMicrovm } from "./microvm.ts";

launchMicrovm(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
