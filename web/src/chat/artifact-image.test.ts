import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactImage } from "./Cards.tsx";
import { ImageFile } from "./Files.tsx";

/** An artifact that is an image, in a message: the image as an attached one shows, captioned, opening the artifact. */
const drawn = (versions: number, onOpen: (() => void) | undefined = () => {}) =>
	renderToStaticMarkup(createElement(ArtifactImage, { src: "blob:coast", title: "Coast photo", versions, onOpen }));

describe("an artifact that is an image", () => {
	it("shows the image at an attached image's width, with its title beneath", () => {
		const html = drawn(1);
		expect(html).toContain('<img src="blob:coast" alt="Coast photo"');
		expect(html).toContain("width:280px");
		expect(html).toMatch(/<figcaption[^>]*>.*Coast photo.*<\/figcaption>/);
		// the image, never the file card: no icon tile, no Open button of its own
		expect(html).not.toContain("data-tile");
		expect(html).not.toMatch(/>\s*Open\s*</);
	});

	it("says how many versions only when there is more than one", () => {
		expect(drawn(1)).not.toContain("version");
		expect(drawn(2)).toContain("· 2 versions");
		expect(drawn(3)).toContain("· 3 versions");
	});

	it("opens the artifact on a tap, where an attached image zooms", () => {
		const artifact = drawn(3);
		expect(artifact).toContain('<button type="button" aria-label="Open Coast photo"');
		expect(artifact).not.toContain("data-rmiz");
		const attached = renderToStaticMarkup(createElement(ImageFile, { src: "blob:coast", alt: "coast.jpg" }));
		expect(attached).toContain("data-rmiz");
	});
});
