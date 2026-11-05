/**
 * The app: the shell (`app/Shell.tsx`) once the page holds the owner's token; without one, or with one the daemon no
 * longer takes, the page says where its link is. `#/specimen` shows every component, with no token needed.
 */
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Shell } from "./app/Shell.tsx";
import { hasToken, onToken, onUnauthorized } from "./lib/api.ts";
import { Specimen } from "./routes/Specimen.tsx";

function useSpecimen(): boolean {
	const [hash, setHash] = useState(location.hash);
	useEffect(() => {
		const changed = () => setHash(location.hash);
		addEventListener("hashchange", changed);
		return () => removeEventListener("hashchange", changed);
	}, []);
	return hash.startsWith("#/specimen");
}

export function App() {
	const specimen = useSpecimen();
	const [refused, setRefused] = useState(!hasToken());
	useEffect(() => {
		return onUnauthorized(() => setRefused(true));
	}, []);
	useEffect(() => {
		return onToken(() => setRefused(!hasToken()));
	}, []);
	if (specimen) return <Specimen />;
	if (refused) return <Connect />;
	return (
		<>
			<Shell />
			<Toaster />
		</>
	);
}

function Connect() {
	return (
		<main className="flex h-svh items-center justify-center bg-paper p-6 text-ink">
			<div className="flex max-w-sm flex-col gap-3 text-body">
				<h1 className="text-heading font-semibold">Connect to banda</h1>
				<p className="text-ink-2">
					This page needs your link. Open the one <code className="font-code">banda serve</code> printed when it
					started, or the one this prints:
				</p>
				<pre className="rounded-tile bg-paper-2 px-4 py-3 font-code text-ui">banda status</pre>
				<p className="text-ui text-ink-2">
					The link survives restarts; this page shows again only in a new browser or after the link is renewed.
				</p>
			</div>
		</main>
	);
}
