import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	type AgentPublicationHistory,
	type AgentView,
	agentPublications,
	answerAgent,
	type RetainedAgentFile,
	retryAgentPublication,
} from "../lib/api.ts";
import { failureWords } from "../lib/attempt.ts";
import { withoutFace } from "./agent-preview.ts";

type History =
	| { kind: "closed" }
	| { kind: "loading" }
	| { kind: "failed"; message: string }
	| { kind: "ready"; page: AgentPublicationHistory };

function Version({ title, text }: { title: string; text: string }) {
	return (
		<details className="min-w-0">
			<summary className="cursor-pointer py-2 font-medium">{title}</summary>
			<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-field bg-paper-3 p-3 font-sans text-body">
				{withoutFace(text)}
			</pre>
		</details>
	);
}

function RetainedVersion({ version }: { version: RetainedAgentFile }) {
	const [copied, setCopied] = useState(false);
	if (version.kind === "unreadable") return <p>{version.message}</p>;
	return (
		<div className="min-w-0">
			<Version title="Earlier workspace version" text={version.text} />
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => {
					void navigator.clipboard.writeText(version.text).then(
						() => setCopied(true),
						() => toast.error("Couldn't copy the version", { description: "Select the text above to copy it." }),
					);
				}}
			>
				{copied ? "Copied" : "Copy version"}
			</Button>
		</div>
	);
}

export function AgentPublication({
	agent,
	onSaved,
}: {
	agent: AgentView;
	onSaved: (agents: readonly AgentView[]) => void;
}) {
	const [history, setHistory] = useState<History>({ kind: "closed" });
	const [acting, setActing] = useState(false);
	const [error, setError] = useState<string>();
	const publication = agent.publication;
	if (publication === undefined) return null;
	const change = agent.change;
	const reviewedSha = change === undefined ? agent.accepted?.sha : change.kind === "removed" ? null : change.sha;
	const load = async (before?: number) => {
		const previous = history.kind === "ready" ? history.page.items : [];
		setHistory({ kind: "loading" });
		try {
			const page = await agentPublications(agent.name, before);
			setHistory({ kind: "ready", page: { ...page, items: [...previous, ...page.items] } });
		} catch (error) {
			setHistory({ kind: "failed", message: failureWords(error) });
		}
	};
	const act = async (run: () => Promise<AgentView[]>) => {
		setActing(true);
		setError(undefined);
		try {
			onSaved(await run());
			setHistory({ kind: "closed" });
		} catch (error) {
			setError(failureWords(error));
		} finally {
			setActing(false);
		}
	};
	return (
		<Alert role={publication.state === "retained" ? "status" : "alert"}>
			<AlertTitle>
				{publication.state === "pending"
					? "Your change is saved"
					: publication.state === "conflict"
						? "Two versions were kept"
						: "Earlier versions are available"}
			</AlertTitle>
			<AlertDescription className="min-w-0">
				<p>{publication.message}</p>
				<details
					onToggle={(event) => {
						if (event.currentTarget.open && history.kind === "closed") void load();
					}}
				>
					<summary className="cursor-pointer py-2 font-medium">Review versions</summary>
					<div className="flex min-w-0 flex-col gap-3">
						{agent.accepted === undefined ? null : <Version title="Your saved version" text={agent.accepted.text} />}
						{change !== undefined && change.kind !== "removed" && change.text !== undefined ? (
							<Version title="Current workspace version" text={change.text} />
						) : change?.kind === "removed" ? (
							<p>The workspace file was removed. Your saved version is still in effect.</p>
						) : null}
						{publication.state === "retained" ? null : (
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									disabled={acting || reviewedSha === undefined}
									onClick={() => {
										if (reviewedSha !== undefined)
											void act(() => retryAgentPublication(agent.name, publication.id, reviewedSha));
									}}
								>
									Use my saved version
								</Button>
								{change !== undefined &&
								change.kind !== "removed" &&
								change.sha !== undefined &&
								change.agent !== undefined ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={acting}
										onClick={() => void act(() => answerAgent(agent.name, true, change.sha ?? null))}
									>
										Use workspace version
									</Button>
								) : null}
							</div>
						)}
						{error === undefined ? null : <p role="alert">{error}</p>}
						{history.kind === "loading" ? <p role="status">Loading earlier versions…</p> : null}
						{history.kind === "failed" ? (
							<div>
								<p role="alert">{history.message}</p>
								<Button type="button" variant="outline" size="sm" onClick={() => void load()}>
									Try again
								</Button>
							</div>
						) : history.kind === "ready" ? (
							<>
								{history.page.items.map((item) => (
									<div key={item.id} className="flex min-w-0 flex-col gap-2">
										{item.saved === null ? null : <Version title="Earlier saved version" text={item.saved.text} />}
										{item.retained.map((version) => (
											<RetainedVersion key={version.path} version={version} />
										))}
									</div>
								))}
								{history.page.next === undefined ? null : (
									<Button type="button" variant="outline" size="sm" onClick={() => void load(history.page.next)}>
										Show older versions
									</Button>
								)}
							</>
						) : null}
					</div>
				</details>
			</AlertDescription>
		</Alert>
	);
}
