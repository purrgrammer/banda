// The desktop app's macOS icons, drawn from web/public/icon.svg (the face the web app wears):
//   desktop/build/icon-mac.png        the app's icon: the face alone, cropped to its edges and filling the 1024 canvas
//                                     but for a small margin, on no tile.
//   desktop/assets/trayTemplate*.png  the menu bar's: the face's silhouette with its eyes cut out, cropped to its edges.
//                                     A template image is black and alpha; macOS paints it white or black to suit the bar.
//
//   node scripts/desktop-icons.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = join(import.meta.dirname, "..");
const face = readFileSync(join(root, "web", "public", "icon.svg"), "utf8");
const BODY = 'fill="#8a9cc7"';
const EYE = 'fill="#151515"';
if (!face.includes(BODY) || !face.includes(EYE))
	throw new Error("icon.svg no longer has the body and eye fills this reads");

const inner = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// the face's own edges, in icon.svg's 512 space
const bbox = new Resvg(face).getBBox();
if (!bbox) throw new Error("icon.svg draws nothing");
const box = { x: bbox.x, y: bbox.y, size: Math.max(bbox.width, bbox.height) };
box.x -= (box.size - bbox.width) / 2;
box.y -= (box.size - bbox.height) / 2;
const view = `${box.x} ${box.y} ${box.size} ${box.size}`;

function png(svg: string, width: number): Buffer {
	return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

// the app's icon: the face, as large as the canvas allows
const FACE = 920;
const at = (1024 - FACE) / 2;
const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<svg x="${at}" y="${at}" width="${FACE}" height="${FACE}" viewBox="${view}">${inner(face)}</svg>
</svg>`;

// the tray's: the body white and the eyes black in a mask, so the silhouette has holes where the eyes are
const mask = inner(face).replace(BODY, 'fill="#fff"').replaceAll(EYE, 'fill="#000"');
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" width="${box.size}" height="${box.size}">
<mask id="face" maskUnits="userSpaceOnUse" x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}">${mask}</mask>
<rect x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}" fill="#000" mask="url(#face)"/>
</svg>`;

mkdirSync(join(root, "desktop", "build"), { recursive: true });
mkdirSync(join(root, "desktop", "assets"), { recursive: true });
writeFileSync(join(root, "desktop", "build", "icon-mac.png"), png(app, 1024));
// 18 points: the height of a menu bar icon that fills the bar without touching its edges
writeFileSync(join(root, "desktop", "assets", "trayTemplate.png"), png(tray, 18));
writeFileSync(join(root, "desktop", "assets", "trayTemplate@2x.png"), png(tray, 36));
console.log("wrote desktop/build/icon-mac.png and desktop/assets/trayTemplate{,@2x}.png");
