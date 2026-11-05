import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App.tsx";
import { applyTheme } from "./lib/prefs.ts";
import { registerWorker } from "./lib/worker.ts";
import "./styles/globals.css";

applyTheme();

// the installed app's shell, kept for when the daemon cannot be reached, and never stale after a rebuild
registerWorker();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(
	<StrictMode>
		{/* every screen's tooltips, the specimen's too */}
		<TooltipProvider>
			<App />
		</TooltipProvider>
	</StrictMode>,
);
