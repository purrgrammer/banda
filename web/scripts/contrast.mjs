/**
 * The palette audit (`npm run web:contrast`): WCAG 2.1 contrast of every colour of web/src/styles/tokens.css on every
 * paper it sits on, in light and in dark, read from the stylesheet itself so the audit cannot drift from the theme.
 * Exits 1 when a check fails.
 *
 * Text is 4.5:1 everywhere (banda sets no text large enough for the 3:1 allowance); a boundary or a graphic that tells
 * a state (the focus outline, the ring of an agent at work) is 3:1. `--ink-3` only decorates and is not checked.
 * Colours that mean different things must also look different: their OKLab distance is checked too.
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const OKLCH = String.raw`oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)`;
const pairs = [...css.matchAll(new RegExp(String.raw`(--[\w-]+):\s*light-dark\(${OKLCH},\s*${OKLCH}\);`, "g"))];
const theme = (offset) =>
	Object.fromEntries(pairs.map((m) => [m[1], [Number(m[offset]), Number(m[offset + 1]), Number(m[offset + 2])]]));
const themes = { light: theme(2), dark: theme(5) };

const oklab = ([l, c, h]) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];

/** Relative luminance, through linear sRGB (clamped to the gamut). */
function luminance(color) {
	const [l, a, b] = oklab(color);
	const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const [r, g, bl] = [
		4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
		-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
		-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
	].map((v) => Math.min(1, Math.max(0, v)));
	return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
const contrast = (x, y) => {
	const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
	return (hi + 0.05) / (lo + 0.05);
};
const distance = (x, y) => 100 * Math.hypot(...oklab(x).map((v, i) => v - oklab(y)[i]));

const PAPERS = ["--paper", "--paper-2", "--paper-3"];
/** [token, minimum ratio, what it is] */
const FOREGROUNDS = [
	["--ink", 4.5, "what people read"],
	["--ink-2", 4.5, "secondary text"],
	["--danger", 4.5, "a failure"],
	["--alive", 4.5, "an agent at work; added lines"],
	["--focus", 3, "the focus outline"],
	["--line", 1.2, "a hairline (perceptible, not a boundary)"],
	["--code-token-keyword", 4.5, "code: a keyword"],
	["--code-token-string", 4.5, "code: a string"],
	["--code-token-string-expression", 4.5, "code: a string's expression"],
	["--code-token-constant", 4.5, "code: a number or constant"],
	["--code-token-function", 4.5, "code: a function"],
	["--code-token-link", 4.5, "code: a link"],
	["--code-token-comment", 4.5, "code: a comment"],
	["--code-token-punctuation", 4.5, "code: punctuation"],
	["--code-token-parameter", 4.5, "code: a parameter"],
];
/** [a, b, minimum distance, why they must differ] */
const APART = [
	["--alive", "--danger", 12, "working is not failing"],
	// code's hues are quiet, and never mistaken for a state
	["--code-token-keyword", "--danger", 12, "a keyword is not a failure"],
	["--code-token-constant", "--danger", 12, "a number is not a failure"],
	["--code-token-string", "--alive", 12, "a string is not an agent at work"],
	["--code-token-keyword", "--code-token-string", 8, "a keyword is not a string"],
	["--code-token-constant", "--code-token-string", 8, "a number is not a string"],
];

let failed = 0;
for (const [name, palette] of Object.entries(themes)) {
	console.log(`\n${name}`);
	for (const [token, min, what] of FOREGROUNDS) {
		if (palette[token] === undefined) throw new Error(`tokens.css has no ${token}`);
		const cells = PAPERS.map((paper) => {
			const ratio = contrast(palette[token], palette[paper]);
			if (ratio < min) failed++;
			return `${paper.slice(2)} ${ratio.toFixed(2)}${ratio < min ? " FAIL" : ""}`;
		});
		console.log(`  ${token.padEnd(30)} ${cells.join("  ").padEnd(48)} ${what}`);
	}
	// the primary button: paper on ink
	const primary = contrast(palette["--paper"], palette["--ink"]);
	if (primary < 4.5) failed++;
	console.log(`  primary    paper on ink ${primary.toFixed(2)}${primary < 4.5 ? " FAIL" : ""}`);
	for (const [a, b, min, why] of APART) {
		const d = distance(palette[a], palette[b]);
		if (d < min) failed++;
		console.log(`  ${a.slice(2)}/${b.slice(2)} ΔE ${d.toFixed(1)}${d < min ? ` FAIL (< ${min})` : ""}  ${why}`);
	}
}
if (failed > 0) {
	console.log(`\n${failed} check(s) below target.`);
	process.exit(1);
}
console.log("\nEvery colour meets its target.");
