/**
 * The confirm every destructive action asks first (forgetting a fact, removing a member, taking back a permission,
 * archiving an agent): what it does in a title and a line, the action named by its verb, and a way to keep things as
 * they are. `children` is the control that opens it; without one, `open` and `onOpenChange` hold it, for a menu's item
 * that opens it after the menu closes.
 */
import { type ReactNode, useRef } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** What opened a confirm: the button of the menu the focus is in (a menu names its button), else the control that has it. */
function openerOf(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || active === document.body) return null;
	const button = active.closest('[role="menu"]')?.getAttribute("aria-labelledby");
	return (button ? document.getElementById(button) : null) ?? active;
}

export function Confirm({
	title,
	body,
	action,
	keep = "Cancel",
	onConfirm,
	children,
	open,
	onOpenChange,
}: {
	title: string;
	body: string;
	/** The destructive verb: "Forget", "Remove", "Revoke". */
	action: string;
	keep?: string;
	onConfirm?: (() => void) | undefined;
	children?: ReactNode;
	open?: boolean | undefined;
	onOpenChange?: ((open: boolean) => void) | undefined;
}) {
	// Held open from outside, it has no control of its own to give the focus back to, and the menu item that opened it
	// is gone by the time it closes. So it notes who opened it while that still has the focus: as it renders open.
	const opener = useRef<HTMLElement | null>(null);
	const was = useRef(false);
	if (children === undefined && open === true && !was.current) opener.current = openerOf();
	was.current = open === true;
	return (
		<AlertDialog
			{...(open === undefined ? {} : { open })}
			onOpenChange={(next) => {
				// opened by its own control: that control, noted while it has the focus, for the same return
				if (next && children !== undefined) opener.current = openerOf();
				onOpenChange?.(next);
			}}
		>
			{children === undefined ? null : <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>}
			<AlertDialogContent
				size="sm"
				onCloseAutoFocus={(event) => {
					const to = opener.current;
					if (to === null) return;
					if (to.isConnected && !to.matches(":disabled")) {
						event.preventDefault();
						to.focus();
						return;
					}
					// the act took its opener away (an Archive the archive put Unarchive in place of) or disabled it while
					// it runs (a Remove): the focus goes to the page's title, never to the page
					const title = document.querySelector<HTMLElement>("h1[data-page-title]");
					if (title === null) return;
					event.preventDefault();
					title.focus();
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle className="[overflow-wrap:anywhere]">{title}</AlertDialogTitle>
					<AlertDialogDescription>{body}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{keep}</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={onConfirm}>
						{action}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
