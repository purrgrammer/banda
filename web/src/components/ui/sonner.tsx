/**
 * shadcn's sonner (https://ui.shadcn.com/docs/components/sonner), on banda's tokens and its own theme setting (no
 * next-themes): quiet notes at the bottom of the screen, a failure's with its way on ("Try again").
 */
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/lib/prefs";

function Toaster(props: ToasterProps) {
	const theme = useTheme();
	return (
		<Sonner
			theme={theme}
			position="bottom-center"
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				error: <CircleAlertIcon className="size-4 text-danger" />,
			}}
			style={
				{
					"--normal-bg": "var(--paper)",
					"--normal-text": "var(--ink)",
					"--normal-border": "var(--line)",
					"--border-radius": "14px",
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast: "font-text text-ui shadow-composer",
					description: "!text-ink-2",
					actionButton: "!bg-ink !text-paper !rounded-full !font-medium",
				},
			}}
			{...props}
		/>
	);
}

export { Toaster };
