/** Controls: the primitives kept, on banda's theme. One primary per card; the rest are quiet. */
import { ChevronDownIcon, CopyIcon, MoreHorizontalIcon, SmileIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutList } from "../app/Shortcuts.tsx";
import { Group, Section } from "./stage.tsx";

const EmojiPickerPanel = lazy(() => import("@/components/ui/emoji-picker"));

export function Controls() {
	const [on, setOn] = useState(true);
	const [emoji, setEmoji] = useState("🦊");
	return (
		<Section id="controls" title="Controls" note="Ink fills the one action that matters; everything else is quiet.">
			<Group label="Keyboard shortcuts (? opens them) · a quiet note, with Try again">
				<div className="w-80 rounded-tile border border-line-soft bg-paper p-4">
					<ShortcutList />
				</div>
				<Button
					variant="outline"
					onClick={() =>
						toast.error("Couldn't approve", {
							description: "banda on this computer didn't answer. Check it's still running.",
							action: { label: "Try again", onClick: () => {} },
						})
					}
				>
					Show a failure
				</Button>
			</Group>
			<Group label="Buttons: primary · outline · quiet · danger · link">
				<Button>Comment</Button>
				<Button variant="outline">Edit</Button>
				<Button variant="ghost">Don't</Button>
				<Button variant="destructive">Sign out</Button>
				<Button variant="link">What it was</Button>
			</Group>
			<Group label="Sizes and icons">
				<Button size="lg">Sign in to start</Button>
				<Button size="sm">Run now</Button>
				<Button size="xs" variant="outline">
					Copy code
				</Button>
				<Button size="icon" variant="ghost" aria-label="Copy">
					<CopyIcon />
				</Button>
				<Button size="icon-sm" variant="ghost" aria-label="More">
					<MoreHorizontalIcon />
				</Button>
				<Button disabled>Send</Button>
			</Group>
			<Group label="Fields" className="items-start">
				<Input className="w-56" placeholder="Name" defaultValue="Mara" aria-label="Name" />
				<Textarea
					className="min-h-24 w-80"
					aria-label="Personality"
					placeholder="Warm and brief. Plans trips for the family, keeps to the budget, and asks before booking."
				/>
			</Group>
			<Group label="A switch, labelled by what it does">
				<div className="flex items-center gap-3 text-ui">
					<Switch id="specimen-switch" checked={on} onCheckedChange={setOn} />
					<label htmlFor="specimen-switch">GitHub · @bandarra</label>
				</div>
			</Group>
			<Group label="Menus, popovers and tooltips">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline">
							Mara <ChevronDownIcon />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuItem>Settings</DropdownMenuItem>
						<DropdownMenuItem>Pause routines</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem>Show how the work is done</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Popover>
					<PopoverTrigger asChild>
						<Button variant="outline" aria-label="Pick an emoji">
							<span className="text-[18px] leading-none">{emoji}</span>
							<SmileIcon />
						</Button>
					</PopoverTrigger>
					<PopoverContent className="h-96 w-80 p-0" align="start">
						<Suspense fallback={<Skeleton className="m-3 h-80" />}>
							<EmojiPickerPanel className="h-full" onPick={setEmoji} />
						</Suspense>
					</PopoverContent>
				</Popover>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button variant="ghost">10:42</Button>
					</TooltipTrigger>
					<TooltipContent>Tuesday 3 November, 10:42</TooltipContent>
				</Tooltip>
			</Group>
			<Group label="The emoji picker: search, skin tone, categories, recent">
				<div className="h-80 w-80 overflow-hidden rounded-tile border border-line bg-paper">
					<Suspense fallback={<Skeleton className="m-3 h-72" />}>
						<EmojiPickerPanel className="h-full" recent={["🦊", "🫏", "🐙"]} onPick={setEmoji} />
					</Suspense>
				</div>
			</Group>
			<Group label="Loading">
				<div className="flex items-center gap-3">
					<Skeleton className="size-10 rounded-full" />
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-3.5 w-28" />
						<Skeleton className="h-3 w-44" />
					</div>
				</div>
			</Group>
		</Section>
	);
}
