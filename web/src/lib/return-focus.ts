import { useLayoutEffect, useRef } from "react";

/**
 * Focus back where a dialog came from. Radix's Dialog focuses its Trigger on close, but a dialog opened from state (a
 * shortcut, a header button) has none, so focus would fall to the body. This remembers what was focused as the dialog
 * opened (before Radix moves focus into it) and hands `onCloseAutoFocus` that puts it back.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
	const opener = useRef<HTMLElement | null>(null);
	// a layout effect: it runs before the content's own effects move focus into the dialog
	useLayoutEffect(() => {
		if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}, [open]);
	return (event) => {
		event.preventDefault();
		opener.current?.focus();
	};
}
