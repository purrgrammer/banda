// What of a home folder's stat stays while the home lives where it is (src/wallet/home-id.ts `bindingOf`), and what a
// copy changes. Run: `node binding.mjs` (macOS: also a remount of a disk image; Linux: run-linux.sh as root adds a
// loop-device remount). Prints one line per case: which of dev, ino, birthtime and ctime held.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIELDS = ["dev", "ino", "birthtimeNs", "ctimeNs"];
const look = (path) => {
	const s = statSync(path, { bigint: true });
	return Object.fromEntries(FIELDS.map((f) => [f, s[f]]));
};
const report = (name, before, after) => {
	const held = FIELDS.map((f) => `${f}=${before[f] === after[f] ? "same" : "moved"}`).join(" ");
	console.log(`${name}: ${held}`);
};

console.log(`platform ${process.platform} ${process.arch}, node ${process.version}`);
const area = realpathSync(mkdtempSync(join(tmpdir(), "banda-binding-")));
try {
	const home = join(area, "home");
	mkdirSync(home);
	const first = look(home);
	console.log(`birthtime ${first.birthtimeNs === first.ctimeNs ? "equals" : "differs from"} ctime at creation`);
	console.log(`statx birth time ${first.birthtimeNs === 0n ? "absent (0)" : "present"}`);

	await new Promise((r) => setTimeout(r, 20));
	mkdirSync(join(home, "auth"));
	writeFileSync(join(home, "store.db-wal.tmp"), "x");
	renameSync(join(home, "store.db-wal.tmp"), join(home, "store.db-wal"));
	rmSync(join(home, "store.db-wal"));
	report("entries made, renamed, removed", first, look(home));

	renameSync(home, join(area, "away"));
	renameSync(join(area, "away"), home);
	report("renamed away and back", first, look(home));

	execFileSync("cp", ["-Rp", home, join(area, "copy")]);
	report("cp -Rp copy", first, look(join(area, "copy")));

	if (process.platform === "darwin") {
		const image = join(area, "vol.dmg");
		const mount = join(area, "mnt");
		mkdirSync(mount);
		execFileSync("hdiutil", ["create", "-size", "8m", "-fs", "APFS", "-volname", "bandaspike", image], {
			stdio: "ignore",
		});
		const attach = () =>
			execFileSync("hdiutil", ["attach", image, "-mountpoint", mount, "-nobrowse"], { stdio: "ignore" });
		const detach = () => execFileSync("hdiutil", ["detach", mount], { stdio: "ignore" });
		attach();
		mkdirSync(join(mount, "home"));
		const onVolume = look(join(mount, "home"));
		detach();
		// a second volume attached first, so the image's volume may get another device number
		const image2 = join(area, "vol2.dmg");
		const mount2 = join(area, "mnt2");
		mkdirSync(mount2);
		execFileSync("hdiutil", ["create", "-size", "8m", "-fs", "APFS", "-volname", "bandaspike2", image2], {
			stdio: "ignore",
		});
		execFileSync("hdiutil", ["attach", image2, "-mountpoint", mount2, "-nobrowse"], { stdio: "ignore" });
		attach();
		report("disk image detached and attached again", onVolume, look(join(mount, "home")));
		detach();
		execFileSync("hdiutil", ["detach", mount2], { stdio: "ignore" });
	}
} finally {
	rmSync(area, { recursive: true, force: true });
}
