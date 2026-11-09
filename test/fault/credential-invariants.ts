export type CredentialScenario = { mode: "proactive" | "401"; revoke: boolean };
export type CredentialSummary = {
	card: boolean;
	accountPresent: boolean;
	credentialPresent: boolean;
	versioned: boolean;
	private: boolean;
	readingAccounts: string[];
	commits: number;
	points: Record<string, number>;
};
/** Shared by generated thrown/kill scenarios and the sweep; no credential bytes leave the worker. */
export function credentialProblems(summary: CredentialSummary, scenario: CredentialScenario): string[] {
	const errors: string[] = [];
	if (!summary.card) errors.push("owner could not recover the read");
	if (summary.accountPresent !== summary.credentialPresent) errors.push("credential/account lifecycle split");
	if (summary.accountPresent === scenario.revoke) errors.push("wrong final account presence");
	if (!scenario.revoke && !summary.versioned) errors.push("unversioned credential or sign-in generation");
	if (!summary.private) errors.push("credential reached readings");
	if (summary.readingAccounts.some((account) => account !== "alice")) errors.push("cross-account reading");
	if (scenario.revoke && summary.readingAccounts.length !== 0) errors.push("revoked reading survived");
	return errors;
}
