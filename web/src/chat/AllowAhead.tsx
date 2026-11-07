/**
 * Allow an agent a connection's write without asking, wider than one object (DESIGN.md "Permissions"): which action,
 * where (one place, or anywhere), as which account and for how long, then the exact sentence the daemon will store.
 * Anywhere says its consequence plainly. The words are the daemon's templates, only filled here.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConnectionToolView } from "../../../src/server/api.ts";
import { grainSentence, placeValues, untilWords } from "../lib/permissions.ts";
import { Field } from "./RoutineEditor.tsx";

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** A write that may be allowed wider than one object: the tool as the model knows it, and its grains' words. */
export type AheadAction = {
	readonly tool: string;
	readonly grains: NonNullable<ConnectionToolView["grains"]>;
};

/** What the owner allows, as `POST /api/agents/:agent/permissions` takes it. */
export type AheadAsked = {
	readonly tool: string;
	readonly account: string;
	readonly grain: "place" | "action";
	readonly place?: { readonly [placeholder: string]: string };
	readonly scope: "always" | "until";
	readonly until?: number;
};

/** A moment as a `datetime-local` input spells it, in the owner's zone. */
const localInput = (at: number) => {
	const date = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const capital = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

export function AllowAhead({
	agent,
	actions,
	accounts,
	now = Date.now(),
	initial = {},
	busy = false,
	error,
	onAllow,
	onCancel,
}: {
	agent: string;
	/** The writes that declare grains, of one connection. */
	actions: readonly AheadAction[];
	/** Its accounts switched on for the agent: the key, and how the owner reads it ("@bandarra"). */
	accounts: readonly { readonly account: string; readonly label: string }[];
	now?: number;
	/** Where it starts: the specimen's states. */
	initial?: { readonly tool?: string; readonly grain?: "place" | "action"; readonly place?: string };
	busy?: boolean;
	error?: string | undefined;
	onAllow?: (asked: AheadAsked) => void;
	onCancel?: () => void;
}) {
	const [tool, setTool] = useState(initial.tool ?? actions[0]?.tool ?? "");
	const [account, setAccount] = useState(accounts[0]?.account ?? "");
	const action = actions.find((each) => each.tool === tool) ?? actions[0];
	const [chosen, setGrain] = useState<"place" | "action">(initial.grain ?? "place");
	const grain = action?.grains.place === undefined ? "action" : action.grains.action === undefined ? "place" : chosen;
	const [typed, setTyped] = useState(initial.place ?? "");
	const [lasts, setLasts] = useState<"always" | "until">("always");
	const [until, setUntil] = useState(localInput(now + 24 * 60 * 60_000));
	if (action === undefined) return null;
	const label = accounts.find((each) => each.account === account)?.label ?? account;
	const place = action.grains.place;
	const values = grain === "place" && place !== undefined ? placeValues(place.place, typed) : {};
	const words = grain === "place" ? place?.words : action.grains.action?.words;
	const sentence = words === undefined || values === undefined ? undefined : grainSentence(words, values, label);
	const at = new Date(until).getTime();
	const timeOk = lasts === "always" || (Number.isFinite(at) && at > now && at - now <= WEEK_MS);
	const when = lasts === "always" ? "always" : timeOk ? `until ${untilWords(at, now)}` : undefined;
	const example = place?.place.replace(/\{([a-z_]+)\}/g, "$1") ?? "";
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (sentence === undefined || !timeOk || busy) return;
				onAllow?.({
					tool: action.tool,
					account,
					grain,
					...(grain === "place" && values !== undefined ? { place: values } : {}),
					scope: lasts,
					...(lasts === "until" ? { until: at } : {}),
				});
			}}
		>
			<Field label="What">
				<Select value={action.tool} onValueChange={setTool}>
					<SelectTrigger aria-label="What it may do" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{actions.map((each) => (
							<SelectItem key={each.tool} value={each.tool}>
								{capital(each.grains.what)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			{accounts.length > 1 ? (
				<Field label="As">
					<Select value={account} onValueChange={setAccount}>
						<SelectTrigger aria-label="As which account" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{accounts.map((each) => (
								<SelectItem key={each.account} value={each.account}>
									{each.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			) : null}
			<Field label="Where">
				{place !== undefined && action.grains.action !== undefined ? (
					<ToggleGroup
						type="single"
						variant="outline"
						size="sm"
						aria-label="Where"
						value={grain}
						onValueChange={(value) => {
							if (value === "place" || value === "action") setGrain(value);
						}}
						className="w-full"
					>
						<ToggleGroupItem value="place" className="flex-1">
							In one place
						</ToggleGroupItem>
						<ToggleGroupItem value="action" className="flex-1">
							Anywhere
						</ToggleGroupItem>
					</ToggleGroup>
				) : null}
				{grain === "place" ? (
					<Input
						aria-label="Place"
						placeholder={example}
						value={typed}
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						onChange={(event) => setTyped(event.target.value)}
					/>
				) : null}
				{grain === "place" && typed.trim() !== "" && values === undefined ? (
					<span className="text-meta text-danger">{`Write it as ${example}.`}</span>
				) : null}
				{grain === "action" ? (
					<span className="text-meta text-danger">
						{`${agent} could ${action.grains.what} anywhere ${label} can, without asking.`}
					</span>
				) : null}
			</Field>
			<Field label="For how long">
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					aria-label="For how long"
					value={lasts}
					onValueChange={(value) => {
						if (value === "always" || value === "until") setLasts(value);
					}}
					className="w-full"
				>
					<ToggleGroupItem value="always" className="flex-1">
						Always
					</ToggleGroupItem>
					<ToggleGroupItem value="until" className="flex-1">
						Until
					</ToggleGroupItem>
				</ToggleGroup>
				{lasts === "until" ? (
					<Input
						type="datetime-local"
						aria-label="Until"
						min={localInput(now)}
						max={localInput(now + WEEK_MS)}
						value={until}
						onChange={(event) => setUntil(event.target.value)}
					/>
				) : null}
				{lasts === "until" && !timeOk ? (
					<span className="text-meta text-danger">Pick a time within the next week; for longer, allow it always.</span>
				) : null}
			</Field>
			<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink">
				{sentence === undefined || when === undefined
					? `Say where, and ${agent} may do it without asking.`
					: `${agent} may ${sentence} without asking, ${when}.`}
			</p>
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
			<div className="flex justify-end gap-2">
				{onCancel === undefined ? null : (
					<Button type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				)}
				<Button type="submit" disabled={sentence === undefined || !timeOk || busy}>
					Allow
				</Button>
			</div>
		</form>
	);
}
