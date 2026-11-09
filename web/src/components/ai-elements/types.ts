/**
 * The few AI SDK types ai-elements' components name, here so they need no `ai` package: what banda passes them is
 * its own, shaped alike.
 */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/** A file in the composer or a message: a URL (an object URL, a blob link) and what it is. */
export type FileUIPart = {
	type: "file";
	mediaType: string;
	filename?: string;
	url: string;
	providerMetadata?: unknown;
};

/** A source an answer cites, as a document. */
export type SourceDocumentUIPart = {
	type: "source-document";
	sourceId: string;
	mediaType: string;
	title: string;
	filename?: string;
	providerMetadata?: unknown;
};

/** A spoken message's words, segment by segment, with when each was said. */
export type TranscriptionResult = {
	text: string;
	segments: { text: string; startSecond: number; endSecond: number }[];
	language?: string;
	durationInSeconds?: number;
};
