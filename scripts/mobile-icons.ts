// Android assets share the web app's face. Run with node scripts/mobile-icons.ts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = new URL("../", import.meta.url).pathname;
const res = join(root, "mobile/android/app/src/main/res");
const face = readFileSync(join(root, "web/public/icon.svg"), "utf8");
const bounds = new Resvg(face).getBBox();
if (!bounds) throw new Error("The face is empty");
const size = Math.max(bounds.width, bounds.height);
const view = `${bounds.x - (size - bounds.width) / 2} ${bounds.y - (size - bounds.height) / 2} ${size} ${size}`;
const inner = face.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
function draw(width: number, height: number, faceSize: number, background: boolean) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
${background ? '<rect width="100%" height="100%" fill="#fafafa"/>' : ""}
<svg x="${(width - faceSize) / 2}" y="${(height - faceSize) / 2}" width="${faceSize}" height="${faceSize}" viewBox="${view}">${inner}</svg></svg>`;
	return new Resvg(svg).render().asPng();
}
for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
	const dir = join(res, `mipmap-${density}`);
	for (const name of ["ic_launcher", "ic_launcher_round"]) {
		writeFileSync(join(dir, `${name}.png`), draw(48 * scale, 48 * scale, 36 * scale, true));
	}
	// Adaptive masks retain the central 66dp of a 108dp layer.
	writeFileSync(join(dir, "ic_launcher_foreground.png"), draw(108 * scale, 108 * scale, 60 * scale, false));
}
for (const dir of readdirSync(res).filter((name) => name.startsWith("drawable"))) {
	if (!readdirSync(join(res, dir)).includes("splash.png")) continue;
	const path = join(res, dir, "splash.png");
	const old = readFileSync(path);
	const width = old.readUInt32BE(16);
	const height = old.readUInt32BE(20);
	writeFileSync(path, draw(width, height, Math.min(width, height) * 0.28, true));
}
writeFileSync(join(res, "drawable/banda_splash_icon.png"), draw(864, 864, 432, false));
