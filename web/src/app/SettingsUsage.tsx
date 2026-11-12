import { type ComponentProps, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { UsageReport } from "../../../src/core/usage.ts";
import { UsagePanel } from "../chat/Usage.tsx";
import { api } from "../lib/api.ts";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; report: UsageReport };

export function SettingsUsage(props: Omit<ComponentProps<typeof UsagePanel>, "report">) {
	const [state, setState] = useState<State>({ kind: "loading" });
	useEffect(() => {
		if (state.kind !== "loading") return;
		let active = true;
		void api<UsageReport>("/usage").then(
			(report) => {
				if (active) setState({ kind: "ready", report });
			},
			() => {
				if (active) setState({ kind: "error" });
			},
		);
		return () => {
			active = false;
		};
	}, [state.kind]);
	switch (state.kind) {
		case "loading":
			return (
				<p role="status" className="flex items-center gap-2 text-ui text-ink-2">
					<Spinner /> Loading usage…
				</p>
			);
		case "error":
			return (
				<div role="alert" className="flex items-center gap-3 text-ui text-ink-2">
					Couldn’t load model usage.
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setState({ kind: "loading" });
						}}
					>
						Try again
					</Button>
				</div>
			);
		case "ready":
			return <UsagePanel report={state.report} {...props} />;
	}
}
