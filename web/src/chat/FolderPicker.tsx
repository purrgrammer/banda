/**
 * The code folder picker, inline in the connect dialog: a browser cannot hand an app a folder's path, so the daemon
 * lists the folders on the owner's computer and this steps through them. The folder shown is the one picked: a path
 * bar of its parents (each one a click away, or typed), the projects (git repositories) in it, which are what tasks
 * work in, and the folders in it, each a click into. Nothing is read but folder names.
 */
import {
	ChevronRightIcon,
	CornerDownLeftIcon,
	FolderIcon,
	GitBranchIcon,
	HomeIcon,
	PencilIcon,
	XIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FolderListing } from "../lib/api.ts";

/** A count of projects in words: 1 project, 12 projects; none says nothing. */
export const projectsWord = (count: number) => (count === 0 ? "" : count === 1 ? "1 project" : `${count} projects`);

/** The projects a listing's folder holds: its repositories, and theirs below. */
export const projectsIn = (listing: FolderListing | undefined) =>
	(listing?.folders ?? []).reduce((sum, one) => sum + (one.repo ? 1 : one.projects), 0);

/** A folder's own name, as the button that picks it says it: banda-scratch; the home is "Home". */
export const folderName = (path: string) => {
	const last = path.replace(/\/+$/, "").split("/").pop() ?? path;
	return last === "~" || last === "" ? "Home" : last;
};

/** The path bar's parts: ~, ~/code, ~/code/banda, each with its name. */
const crumbsOf = (path: string) => {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts.map((name, at) => ({ name: name === "" ? "/" : name, path: parts.slice(0, at + 1).join("/") || "/" }));
};

/** More folders and projects than this, and a filter shows. */
const FILTER_FROM = 12;
/** The projects named before "and N more". */
const PROJECTS_SHOWN = 5;

export function FolderBrowser({
	at,
	browse,
	onAt,
}: {
	/** The folder to show: the field's, else the daemon's suggestion. */
	at: string;
	browse: (path?: string) => Promise<FolderListing>;
	/** It moved: the folder shown now, and what is in it. */
	onAt: (path: string, listing: FolderListing) => void;
}) {
	const [listing, setListing] = useState<FolderListing | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [typing, setTyping] = useState<string | undefined>(undefined);
	const [filter, setFilter] = useState("");
	const [everyProject, setEveryProject] = useState(false);
	// the folder shown, and the latest look: an answer to an older one is dropped
	const shown = useRef<string | undefined>(undefined);
	const latest = useRef(0);
	const go = useCallback(
		(path: string | undefined) => {
			const look = ++latest.current;
			return browse(path === undefined || path.trim() === "" ? undefined : path.trim()).then(
				(found) => {
					if (look !== latest.current) return;
					shown.current = found.path;
					setListing(found);
					setError(undefined);
					setTyping(undefined);
					setFilter("");
					setEveryProject(false);
					onAt(found.path, found);
				},
				(failed: unknown) => {
					if (look !== latest.current) return;
					setError(failed instanceof Error ? failed.message : String(failed));
				},
			);
		},
		[browse, onAt],
	);
	// told where to start, or moved from outside: look there (its own moves come back as the folder shown)
	useEffect(() => {
		if (at !== shown.current) void go(at);
	}, [at, go]);
	const matches = (name: string) => name.toLowerCase().includes(filter.trim().toLowerCase());
	const projects = (listing?.folders ?? []).filter((one) => one.repo && matches(one.name));
	const folders = (listing?.folders ?? []).filter((one) => !one.repo && matches(one.name));
	const shownProjects = everyProject || filter.trim() !== "" ? projects : projects.slice(0, PROJECTS_SHOWN);
	const count = projectsIn(listing);
	return (
		<div className="flex min-h-0 flex-col overflow-hidden rounded-field border border-line-soft">
			<div className="flex h-11 shrink-0 items-center gap-1 border-b border-line-soft bg-paper-2 px-1.5">
				{typing === undefined ? (
					<>
						<nav aria-label="Folder" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
							{crumbsOf(listing?.path ?? at).map((crumb, index, all) => (
								<Fragment key={crumb.path}>
									{index === 0 ? null : <ChevronRightIcon className="size-3.5 shrink-0 text-ink-3" />}
									{index === all.length - 1 ? (
										<span className="flex shrink-0 items-center px-1.5 text-ui font-medium text-ink">
											{crumb.name === "~" ? "Home" : crumb.name}
										</span>
									) : (
										<Button
											variant="ghost"
											size="xs"
											className="shrink-0 text-ink-2"
											onClick={() => void go(crumb.path)}
										>
											{crumb.name === "~" ? <HomeIcon aria-label="Home" /> : crumb.name}
										</Button>
									)}
								</Fragment>
							))}
						</nav>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Type a path"
							onClick={() => setTyping(listing?.path ?? at)}
						>
							<PencilIcon />
						</Button>
					</>
				) : (
					<form
						className="flex flex-1 items-center gap-1"
						onSubmit={(event) => {
							event.preventDefault();
							void go(typing);
						}}
					>
						<Input
							autoFocus
							aria-label="Folder path"
							value={typing}
							className="h-8 font-code text-meta"
							placeholder="~/code"
							onChange={(event) => setTyping(event.target.value)}
						/>
						<Button type="submit" variant="ghost" size="icon-xs" aria-label="Go there">
							<CornerDownLeftIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Stop typing"
							onClick={() => {
								setTyping(undefined);
								setError(undefined);
							}}
						>
							<XIcon />
						</Button>
					</form>
				)}
			</div>
			<div className="flex h-72 flex-col overflow-y-auto">
				{(listing?.folders.length ?? 0) > FILTER_FROM ? (
					<div className="sticky top-0 z-10 border-b border-line-soft bg-paper px-2 py-1.5">
						<Input
							aria-label="Filter"
							value={filter}
							placeholder="Filter"
							className="h-8 text-ui"
							onChange={(event) => setFilter(event.target.value)}
						/>
					</div>
				) : null}
				{error === undefined ? null : (
					<p className="border-b border-line-soft px-3 py-2 text-meta text-danger">{error}</p>
				)}
				{listing === undefined ? (
					<p className="px-3 py-3 text-ui text-ink-2">{error === undefined ? "Looking…" : ""}</p>
				) : listing.folders.length === 0 ? (
					<p className="px-3 py-3 text-ui text-ink-2">Nothing in here: no folders, no projects.</p>
				) : folders.length + projects.length === 0 ? (
					<p className="px-3 py-3 text-ui text-ink-2">Nothing here matches.</p>
				) : (
					<>
						{folders.length === 0 ? null : (
							<section aria-label="Folders" className="flex flex-col py-1">
								<h3 className="px-3 pt-1.5 pb-1 text-meta font-medium text-ink-2">Folders</h3>
								{folders.map((one) => (
									<button
										key={one.path}
										type="button"
										onClick={() => void go(one.path)}
										className="flex h-9 w-full shrink-0 items-center gap-2.5 px-3 text-left text-ui text-ink hover:bg-paper-3 focus-visible:bg-paper-3 focus-visible:outline-none"
									>
										<FolderIcon className="size-4 shrink-0 text-ink-2" />
										<span className="min-w-0 flex-1 truncate">{one.name}</span>
										<span className="shrink-0 text-meta text-ink-2">{projectsWord(one.projects)}</span>
										<ChevronRightIcon className="size-4 shrink-0 text-ink-3" />
									</button>
								))}
							</section>
						)}
						{projects.length === 0 ? null : (
							<section
								aria-label="Projects here"
								className={folders.length === 0 ? "flex flex-col py-1" : "flex flex-col border-t border-line-soft py-1"}
							>
								<h3 className="px-3 pt-1.5 pb-1 text-meta font-medium text-ink-2">Projects here</h3>
								{shownProjects.map((one) => (
									<span key={one.path} className="flex h-8 shrink-0 items-center gap-2.5 px-3 text-ui text-ink-2">
										<GitBranchIcon className="size-4 shrink-0" />
										<span className="min-w-0 truncate">{one.name}</span>
									</span>
								))}
								{shownProjects.length < projects.length ? (
									<Button
										variant="ghost"
										size="xs"
										className="mx-1.5 self-start text-ink-2"
										onClick={() => setEveryProject(true)}
									>
										and {projects.length - shownProjects.length} more
									</Button>
								) : null}
							</section>
						)}
					</>
				)}
			</div>
			<p className="shrink-0 border-t border-line-soft bg-paper-2 px-3 py-2 text-meta text-ink-2">
				{listing === undefined
					? " "
					: count === 0
						? "No projects in here yet. Pick the folder your git repositories are in."
						: count === 1
							? "Each task works in its one project."
							: `Each task works in one of its ${projectsWord(count)}.`}
			</p>
		</div>
	);
}
