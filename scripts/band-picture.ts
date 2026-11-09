/**
 * Draws the band as site/band-layout.ts places it into docs/band.svg, the README's header: the site's hero, standing
 * still. `npm run site:band` redraws it after the layout changes.
 */
import { writeFileSync } from "node:fs";
import { getExample, renderAvatarSvg } from "open-bot-avatar";
import { BAND, GAP, HEIGHT } from "../site/band-layout.ts";

const PAD = 12;
const width = BAND.reduce((sum, member) => sum + member.size, 0) + GAP * (BAND.length - 1) + PAD * 2;
let x = PAD;
const faces = BAND.map((member) => {
	const definition = getExample(member.shape);
	if (!definition) throw new Error(`Missing band shape: ${member.shape}`);
	const y = PAD + HEIGHT - member.lift - member.size;
	const cx = x + member.size / 2;
	const cy = y + member.size / 2;
	const face = renderAvatarSvg(definition, {
		color: member.color,
		size: member.size,
		motion: member.still,
		time: 0.8,
	}).replace("<svg ", `<svg x="${x}" y="${y}" `);
	x += member.size + GAP;
	return `<g transform="rotate(${member.tilt} ${cx} ${cy})">${face}</g>`;
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${HEIGHT + PAD * 2}" width="${width}" height="${HEIGHT + PAD * 2}" role="img" aria-label="Mara, Octo, Sancho, Atlas and Otto: the band">${faces.join("")}</svg>\n`;
writeFileSync(new URL("../docs/band.svg", import.meta.url), svg);
