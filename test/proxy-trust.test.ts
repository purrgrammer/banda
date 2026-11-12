import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const python = (() => {
	try {
		execFileSync("python3", ["--version"]);
		return true;
	} catch {
		return false;
	}
})();

it.skipIf(!python)(
	"proxy restart retains unchanged trust bytes and file identity for already mounted computers",
	() => {
		const script = `import importlib.util, os, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("start", sys.argv[1])
start = importlib.util.module_from_spec(spec)
spec.loader.exec_module(start)
with tempfile.TemporaryDirectory() as root:
    authority = pathlib.Path(root) / "authority"
    target = pathlib.Path(root) / "trust"
    authority.write_bytes(b"persistent authority")
    start.publish_trust(authority, target)
    before = target.stat()
    with target.open("rb") as mounted:
        start.publish_trust(authority, target)
        after = target.stat()
        assert (before.st_ino, before.st_mtime_ns) == (after.st_ino, after.st_mtime_ns)
        assert mounted.read() == target.read_bytes() == authority.read_bytes()
        assert after.st_mode & 0o777 == 0o644
    target.unlink()
    start.publish_trust(authority, target)
    assert target.read_bytes() == authority.read_bytes()
print("trust survives restart")`;
		expect(
			execFileSync(
				"python3",
				["-I", "-B", "-c", script, fileURLToPath(new URL("../proxy/start.py", import.meta.url))],
				{ encoding: "utf8" },
			).trim(),
		).toBe("trust survives restart");
	},
);
