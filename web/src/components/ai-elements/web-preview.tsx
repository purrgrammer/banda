/**
 * ai-elements' web-preview (https://elements.ai-sdk.dev/components/web-preview), for an artifact rendered as a page.
 * Adapted to banda, as AGENTS.md requires of anything showing what the box wrote: the frame shows a document given
 * whole (`srcdoc`), never a URL. Its CSP permits inline interactions but no fetch or external resources; the sandbox
 * permits scripts, never same origin, forms, popups or navigation of the app. No caller can widen the sandbox, and
 * the opaque origin cannot read the token or API. The address bar and console stay behind the raw setting.
 */

import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/cn";

type WebPreviewContextValue = {
	readonly url: string;
	readonly consoleOpen: boolean;
	readonly setConsoleOpen: (open: boolean) => void;
};

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

const useWebPreview = () => {
	const context = useContext(WebPreviewContext);
	if (!context) throw new Error("WebPreview components must be used within a WebPreview");
	return context;
};

export type WebPreviewProps = ComponentProps<"div"> & {
	/** What the address bar names: the page's file, never a location the frame loads. */
	url?: string;
};

export const WebPreview = ({ className, children, url = "", ...props }: WebPreviewProps) => {
	const [consoleOpen, setConsoleOpen] = useState(false);
	return (
		<WebPreviewContext.Provider value={{ url, consoleOpen, setConsoleOpen }}>
			<div className={cn("flex size-full flex-col bg-sa-bg", className)} {...props}>
				{children}
			</div>
		</WebPreviewContext.Provider>
	);
};

export type WebPreviewNavigationProps = ComponentProps<"div">;

export const WebPreviewNavigation = ({ className, children, ...props }: WebPreviewNavigationProps) => (
	<div className={cn("flex items-center gap-1 border-b border-sa-divider p-2", className)} {...props}>
		{children}
	</div>
);

/** The page's name, read-only: the frame never navigates. */
export const WebPreviewUrl = ({ className, ...props }: ComponentProps<"output">) => {
	const { url } = useWebPreview();
	return (
		<output
			className={cn(
				"flex h-8 min-w-0 flex-1 items-center truncate rounded-control bg-sa-surface px-3 font-mono text-xs text-sa-muted",
				className,
			)}
			{...props}
		>
			{url}
		</output>
	);
};

export type WebPreviewBodyProps = Omit<ComponentProps<"iframe">, "src" | "sandbox" | "srcDoc" | "allow"> & {
	/** The whole document to show. */
	document: string;
};

export const WebPreviewBody = ({ className, document, title = "Preview", ...props }: WebPreviewBodyProps) => (
	<div className="min-h-0 flex-1">
		<iframe
			className={cn("size-full bg-white", className)}
			title={title}
			referrerPolicy="no-referrer"
			{...props}
			// after the caller's props: no caller widens what the frame may do
			sandbox="allow-scripts"
			srcDoc={document}
		/>
	</div>
);

export type WebPreviewConsoleProps = ComponentProps<"div"> & {
	logs?: readonly { level: "log" | "warn" | "error"; message: string; timestamp: Date }[];
};

export const WebPreviewConsole = ({ className, logs = [], children, ...props }: WebPreviewConsoleProps) => {
	const { consoleOpen, setConsoleOpen } = useWebPreview();
	return (
		<Collapsible
			className={cn("border-t border-sa-divider bg-sa-surface font-mono text-sm", className)}
			onOpenChange={setConsoleOpen}
			open={consoleOpen}
			{...props}
		>
			<CollapsibleTrigger asChild>
				<Button className="flex w-full items-center justify-between p-4 text-left font-medium" variant="ghost">
					Console
					<ChevronDownIcon className={cn("size-4 transition-transform duration-200", consoleOpen && "rotate-180")} />
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="px-4 pb-4">
				<div className="max-h-48 space-y-1 overflow-y-auto">
					{logs.length === 0 ? (
						<p className="text-sa-muted">No console output</p>
					) : (
						logs.map((log, index) => (
							<div
								className={cn(
									"text-xs",
									log.level === "error" && "text-sa-error",
									log.level === "warn" && "text-sa-accent",
								)}
								key={`${log.timestamp.getTime()}-${index}`}
							>
								<span className="text-sa-muted">{log.timestamp.toLocaleTimeString()}</span> {log.message}
							</div>
						))
					)}
					{children}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
};
