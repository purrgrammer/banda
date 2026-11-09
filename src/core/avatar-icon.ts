import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { renderAvatarSvg } from "open-bot-avatar";
import { type AvatarFace, readAvatarFace, writeAvatarFace } from "./avatar-face.ts";

export const ICON_FILES = {
	"/icon.svg": { size: 512, maskable: false, svg: true },
	"/icon-maskable.svg": { size: 512, maskable: true, svg: true },
	"/icon-192.png": { size: 192, maskable: false, svg: false },
	"/icon-512.png": { size: 512, maskable: false, svg: false },
	"/icon-maskable-512.png": { size: 512, maskable: true, svg: false },
	"/apple-touch-icon.png": { size: 180, maskable: false, svg: false },
} as const;
export type IconPath = keyof typeof ICON_FILES;

/** Only validated geometry enters the renderer; never caller-supplied SVG, URLs or markup. */
export function avatarIcon(face: AvatarFace, maskable = false): string {
	const checked = readAvatarFace(writeAvatarFace(face));
	if (!checked.ok) throw new Error("Invalid avatar face");
	const inset = maskable ? 112 : 32;
	const extent = 512 - 2 * inset;
	const background = maskable ? '<rect width="512" height="512" fill="#fcfcfc"/>' : "";
	// Names and ids are not public identity data. A fixed id also gives every icon the same still pose.
	const definition = { ...checked.face.definition, name: "Avatar", id: "icon" };
	const drawing = renderAvatarSvg(definition, { color: checked.face.color, size: extent, reducedMotion: true });
	// The maskable square's corners are inside the required central circle (radius 40% of 512).
	// Clip the renderer's overflow too, so even extreme accepted geometry cannot escape that square.
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Avatar">${background}<g transform="translate(${inset} ${inset})"><svg width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}" overflow="hidden" role="img" aria-label="Avatar">${drawing}</svg></g></svg>`;
}

export function avatarIconPng(face: AvatarFace, size: 180 | 192 | 512, maskable = false): Buffer {
	return png(avatarIcon(face, maskable), size);
}

function png(svg: string, size: number): Buffer {
	// No fonts, resource directory or image resolver: this renderer only sees our own self-contained paths.
	return new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render().asPng();
}

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type IconResponse = { readonly bytes: Buffer; readonly type: string; readonly etag: string };

/** One current face per HTTP server, at most six images. Derived bytes are discarded on identity change. */
export function avatarIcons() {
	let current = "";
	let standard = "";
	let maskable = "";
	let revision = "";
	const images = new Map<IconPath, IconResponse>();
	return (face: AvatarFace) => {
		const key = writeAvatarFace(face);
		if (key !== current) {
			standard = avatarIcon(face);
			maskable = avatarIcon(face, true);
			revision = hash(standard + maskable);
			images.clear();
			current = key;
		}
		return {
			revision,
			image(path: IconPath): IconResponse {
				const hit = images.get(path);
				if (hit) return hit;
				const spec = ICON_FILES[path];
				const svg = spec.maskable ? maskable : standard;
				const bytes = spec.svg ? Buffer.from(svg) : png(svg, spec.size);
				const image = { bytes, type: spec.svg ? "image/svg+xml" : "image/png", etag: `"${hash(bytes)}"` };
				images.set(path, image);
				return image;
			},
		};
	};
}

/** Stable manifest identity, but versioned icon URLs make changed faces visible to install clients. */
export function avatarManifest(revision?: string): string {
	const suffix = revision === undefined ? "" : `?v=${revision}`;
	return JSON.stringify({
		id: "/",
		name: "banda",
		short_name: "banda",
		description: "Your companion, on your own computer.",
		start_url: "/#/",
		scope: "/",
		display: "standalone",
		background_color: "#fcfcfc",
		theme_color: "#fcfcfc",
		icons: Object.entries(ICON_FILES)
			.filter(([path]) => path !== "/apple-touch-icon.png")
			.map(([path, spec]) => ({
				src: path + suffix,
				sizes: spec.svg ? "any" : `${spec.size}x${spec.size}`,
				type: spec.svg ? "image/svg+xml" : "image/png",
				purpose: spec.maskable ? "maskable" : "any",
			})),
	});
}
