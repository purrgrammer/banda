import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmailDraftPreview } from "./EmailDraftPreview.tsx";

describe("a Gmail send draft", () => {
	it("previews recipient, subject, body and attachment details together", () => {
		const html = renderToStaticMarkup(
			createElement(EmailDraftPreview, {
				args: {
					to: "mira@example.test",
					subject: "Planning notes",
					body: "Friday works for me.",
					attachments: [{ name: "notes.pdf", mimeType: "application/pdf", size: 1_258_291 }],
				},
				edits: {},
				readOnly: true,
				onEdit: () => {},
			}),
		);
		expect(html).toContain('aria-label="Email draft preview"');
		expect(html).toContain('aria-label="Email recipient"');
		expect(html).toContain('value="mira@example.test"');
		expect(html).toContain('value="Planning notes"');
		expect(html).toContain("Friday works for me.");
		expect(html).toContain("notes.pdf");
		expect(html).toContain("1.2 MB");
	});

	it("keeps owner edits visible in the preview", () => {
		const html = renderToStaticMarkup(
			createElement(EmailDraftPreview, {
				args: { to: "before@example.test", subject: "Before", body: "Before" },
				edits: { to: "after@example.test", subject: "After", body: "Edited message" },
				readOnly: false,
				onEdit: () => {},
			}),
		);
		expect(html).toContain('value="after@example.test"');
		expect(html).toContain('value="After"');
		expect(html).toContain("Edited message");
		expect(html).not.toContain('readonly=""');
	});
});
