/**
 * The code folder picker: a browser cannot hand an app a folder's path, so the daemon lists the folders on the owner's
 * computer and this steps through them: each folder with the projects (git repositories) in it, up and into, a filter,
 * and "Use" for the one shown. Nothing is read but folder names.
 */
import { ChevronLeftIcon, FolderIcon, FolderOpenIcon, GitBranchIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { FolderListing } from "../lib/api.ts";

/** A count of projects in words: 1 project, 12 projects; none says nothing. */
const projectsWord = (count: number) => (count === 0 ? "" : count === 1 ? "1 project" : `${count} projects`);

export function FolderPicker({
	start,
	browse,
	onPick,
}: {
	/** Where it opens: the field's folder, else the daemon's home. */
	start?: string | undefined;
	browse: (path?: string) => Promise<FolderListing>;
	onPick: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [listing, setListing] = useState<FolderListing | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const go = useCallback(
		(path?: string) => {
			setError(undefined);
			browse(path).then(setListing, (failed: unknown) => {
				setError(failed instanceof Error ? failed.message : String(failed));
				// an unknown start opens the home instead
				if (path !== undefined) void browse().then(setListing, () => {});
			});
		},
		[browse],
	);
	useEffect(() => {
		if (open) go(start?.trim() === "" ? undefined : start);
	}, [open, start, go]);
	const here = listing?.folders.filter((one) => one.repo).length ?? 0;
	const below = listing?.folders.reduce((sum, one) => sum + one.projects, 0) ?? 0;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm">
					<FolderOpenIcon />
					Browse
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" collisionPadding={16} className="w-[min(22rem,calc(100vw-2rem))] p-0">
				<div className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Up a folder"
						disabled={listing?.parent === undefined}
						onClick={() => go(listing?.parent)}
					>
						<ChevronLeftIcon />
					</Button>
					<span className="min-w-0 flex-1 truncate font-code text-meta text-ink">{listing?.path ?? "…"}</span>
				</div>
				<Command>
					<CommandInput placeholder="Filter folders" />
					<CommandList className="max-h-64">
						<CommandEmpty>{error ?? "No folders here."}</CommandEmpty>
						{(listing?.folders ?? []).map((folder) => (
							<CommandItem key={folder.path} value={folder.name} onSelect={() => go(folder.path)}>
								{folder.repo ? <GitBranchIcon className="text-ink-2" /> : <FolderIcon className="text-ink-2" />}
								<span className="min-w-0 flex-1 truncate">{folder.name}</span>
								<span className="shrink-0 text-meta text-ink-2">
									{folder.repo ? "project" : projectsWord(folder.projects)}
								</span>
							</CommandItem>
						))}
					</CommandList>
				</Command>
				<div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
					<span className="min-w-0 flex-1 text-meta text-ink-2">
						{here + below === 0 ? "No projects in it" : `${projectsWord(here + below)} in it`}
					</span>
					<Button
						size="sm"
						disabled={listing === undefined}
						onClick={() => {
							if (listing === undefined) return;
							onPick(listing.path);
							setOpen(false);
						}}
					>
						Use this folder
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
