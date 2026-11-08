/** The owner-facing MCP controls, shared by setup and connection details. No network or credentials here. */
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { McpConfig } from "../../../src/core/mcp-config.ts";
import type { ConnectionView } from "../../../src/server/api.ts";
import { Face } from "./Face.tsx";
import type { Who } from "./Row.tsx";

export function McpServerForm({ busy, onSubmit }: { busy: boolean; onSubmit: (config: McpConfig) => void }) {
	const id = useId();
	const [url, setUrl] = useState("");
	const [service, setService] = useState("");
	const [auth, setAuth] = useState<McpConfig["auth"]>("auto");
	const [client, setClient] = useState("");
	const [scopes, setScopes] = useState("");
	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit({
					url: url.trim(),
					service: service.trim(),
					auth,
					...((auth === "auto" || auth === "oauth") && client.trim() ? { client: client.trim() } : {}),
					...((auth === "auto" || auth === "oauth") && scopes.trim() ? { scopes: scopes.trim().split(/\s+/) } : {}),
				});
			}}
		>
			<FieldGroup>
				<Field>
					<FieldLabel htmlFor={`${id}-url`}>Server address</FieldLabel>
					<Input
						id={`${id}-url`}
						type="url"
						required
						maxLength={2000}
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						placeholder="https://example.com/mcp"
						disabled={busy}
					/>
					<FieldDescription>The server’s remote MCP endpoint, without credentials.</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
					<Input
						id={`${id}-name`}
						value={service}
						onChange={(event) => setService(event.target.value)}
						maxLength={80}
						placeholder="Optional"
						disabled={busy}
					/>
					<FieldDescription>What you’ll call this connection in banda.</FieldDescription>
				</Field>
			</FieldGroup>
			<details className="text-ui">
				<summary className="cursor-pointer text-ink-2">Advanced sign-in settings</summary>
				<FieldGroup className="mt-4">
					<Field>
						<FieldLabel htmlFor={`${id}-auth`}>Sign-in method</FieldLabel>
						<Select value={auth} onValueChange={(value) => setAuth(value as McpConfig["auth"])} disabled={busy}>
							<SelectTrigger id={`${id}-auth`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="auto">Detect automatically</SelectItem>
									<SelectItem value="oauth">OAuth sign-in</SelectItem>
									<SelectItem value="key">Bearer credential</SelectItem>
									<SelectItem value="none">No sign-in</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
					{auth === "auto" || auth === "oauth" ? (
						<>
							<Field>
								<FieldLabel htmlFor={`${id}-client`}>OAuth client ID</FieldLabel>
								<Input
									id={`${id}-client`}
									value={client}
									onChange={(event) => setClient(event.target.value)}
									placeholder="Register automatically"
									maxLength={200}
									disabled={busy}
								/>
								<FieldDescription>Only needed if the service gives you a registered public client.</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-scopes`}>Scopes</FieldLabel>
								<Input
									id={`${id}-scopes`}
									value={scopes}
									onChange={(event) => setScopes(event.target.value)}
									placeholder="Discover from the server"
									maxLength={10000}
									disabled={busy}
								/>
								<FieldDescription>Optional, separated by spaces.</FieldDescription>
							</Field>
						</>
					) : null}
				</FieldGroup>
			</details>
			<p className="text-ui text-ink-2">
				We’ll check how it connects and save its definition. Nothing is given to your agents yet.
			</p>
			<Button type="submit" disabled={busy || !url.trim()} className="self-start">
				{busy ? <Spinner data-icon="inline-start" /> : null}
				{busy ? "Checking server…" : "Check server"}
			</Button>
		</form>
	);
}

export function McpDetails({ view }: { view: Pick<ConnectionView, "notes"> }) {
	return (
		<div className="flex flex-col gap-4 text-ui">
			<details className="rounded-field border border-line-soft p-3">
				<summary className="cursor-pointer font-medium">Introduction from the server</summary>
				<p className="mt-3 text-meta text-ink-2">
					Shown to agents that have access. The server’s instructions grant no permissions.
				</p>
				<p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
					{view.notes || "This server provided no introductory instructions."}
				</p>
			</details>
		</div>
	);
}

export function McpAgents({
	agents,
	selected,
	onSwitch,
	disabled,
}: {
	agents: readonly (Who & { id: string })[];
	selected: readonly string[];
	onSwitch: (agent: string, on: boolean) => void;
	disabled: boolean;
}) {
	const id = useId();
	return (
		<FieldSet>
			<FieldLegend variant="label">Who can use it?</FieldLegend>
			<FieldDescription>Only the agents you select get this connection’s introduction and tools.</FieldDescription>
			<FieldGroup>
				{agents.map((agent) => (
					<Field key={agent.id} orientation="horizontal">
						<Face face={agent.face} name={agent.name} size="message" />
						<FieldLabel htmlFor={`${id}-${agent.id}`}>{agent.name}</FieldLabel>
						<Switch
							id={`${id}-${agent.id}`}
							checked={selected.includes(agent.id)}
							onCheckedChange={(on) => onSwitch(agent.id, on)}
							disabled={disabled}
						/>
					</Field>
				))}
			</FieldGroup>
		</FieldSet>
	);
}
