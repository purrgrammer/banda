/** A byte count in the owner's words: "12 KB", "3.4 MB". Pure, so cards that show sizes load without the API. */
export const sizeOf = (size: number) =>
	size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
