/**
 * The confirm every destructive action asks first (forgetting a fact, removing a member, taking back a permission,
 * archiving an agent): what it does in a title and a line, the action named by its verb, and a way to keep things as
 * they are. `children` is the control that opens it; without one, `open` and `onOpenChange` hold it, for a menu's item
 * that opens it after the menu closes.
 */
import type { ReactNode } from "react";
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
	return (
		<AlertDialog {...(open === undefined ? {} : { open })} {...(onOpenChange === undefined ? {} : { onOpenChange })}>
			{children === undefined ? null : <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>}
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
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
