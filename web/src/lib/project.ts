/** The project, as the owner knows it: the folder's last name ("~/code/banda" is "banda"). Plain, with no UI imports. */
export function projectOf(folder: string): string {
	const name = folder.replace(/\/+$/, "").split("/").at(-1);
	return name === undefined || name === "" || name === "~" ? folder : name;
}
