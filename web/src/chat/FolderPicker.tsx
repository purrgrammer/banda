/**
 * The code folder browser, inline in the connect dialog: a browser cannot hand an app a folder's path, so the daemon
 * lists the folders on the owner's computer and this steps through them: where it is, up, a filter, each folder with
 * the projects (git repositories) in it. The folder shown is the one picked; nothing is read but folder names.
 */
import { ChevronLeftIcon, ChevronRightIcon, FolderIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { FolderListing } from "../lib/api.ts";

/** A count of projects in words: 1 project, 12 projects; none says nothing. */
export const projectsWord = (count: number) => (count === 0 ? "" : count === 1 ? "1 project" : `${count} projects`);

/** The projects a listing's folder holds: its repositories, and theirs below. */
export const projectsIn = (listing: FolderListing | undefined) =>
	(listing?.folders ?? []).reduce((sum, one) => sum + (one.repo ? 1 : one.projects), 0);

export function FolderBrowser({
	at,
	browse,
	onAt,
}: {
	/** The folder shown, which is the one picked: the field's, else the daemon's suggestion. */
	at: string;
	browse: (path?: string) => Promise<FolderListing>;
	/** It moved: the folder shown now, and what is in it. */
	onAt: (path: string, listing: FolderListing) => void;
}) {
	const [listing, setListing] = useState<FolderListing | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	useEffect(() => {
		let gone = false;
		// a quarter of a second after the last key: a path half typed is not browsed
		const timer = setTimeout(() => {
			setError(undefined);
			browse(at.trim() === "" ? undefined : at).then(
				(found) => {
					if (gone) return;
					setListing(found);
					// what is in it, and the daemon's spelling of it (~/code for ~/code/)
					onAt(found.path, found);
				},
				(failed: unknown) => {
					if (gone) return;
					setListing(undefined);
					setError(failed instanceof Error ? failed.message : String(failed));
				},
			);
		}, 250);
		return () => {
			gone = true;
			clearTimeout(timer);
		};
	}, [at, browse, onAt]);
	const go = (path: string) => browse(path).then((found) => onAt(found.path, found), setErrorFrom(setError));
	return (
		<div className="flex min-h-0 flex-col overflow-hidden rounded-field border border-line-soft">
			<div className="flex items-center gap-1.5 border-b border-line-soft bg-paper-2 px-2 py-1.5">
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="Up a folder"
					disabled={listing?.parent === undefined}
					onClick={() => listing?.parent !== undefined && void go(listing.parent)}
				>
					<ChevronLeftIcon />
				</Button>
				<span className="min-w-0 flex-1 truncate font-code text-meta text-ink">{listing?.path ?? at}</span>
				<span className="shrink-0 text-meta text-ink-2">{projectsWord(projectsIn(listing))}</span>
			</div>
			<Command className="min-h-0">
				<CommandInput placeholder="Filter folders" />
				<CommandList className="max-h-56">
					<CommandEmpty>{error ?? (listing === undefined ? "Looking…" : "No folders here.")}</CommandEmpty>
					{(listing?.folders ?? []).map((folder) => (
						<CommandItem key={folder.path} value={folder.name} onSelect={() => void go(folder.path)}>
							{folder.repo ? <GitBranchIcon className="text-ink-2" /> : <FolderIcon className="text-ink-2" />}
							<span className="min-w-0 flex-1 truncate">{folder.name}</span>
							<span className="shrink-0 text-meta text-ink-2">
								{folder.repo ? "project" : projectsWord(folder.projects)}
							</span>
							<ChevronRightIcon className="text-ink-3" />
						</CommandItem>
					))}
				</CommandList>
			</Command>
		</div>
	);
}

const setErrorFrom = (set: (message: string) => void) => (failed: unknown) =>
	set(failed instanceof Error ? failed.message : String(failed));
