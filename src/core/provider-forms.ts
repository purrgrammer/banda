/**
 * The setup forms of built-in providers whose sign-in is more than one key: a cloud's account, project or profile.
 * pi-ai's login for each asks a fixed run of prompts (a choice of method, then text and secrets in order); a form names
 * those prompts as fields, in that order, so the daemon answers them from what the owner typed
 * (`../server/routes/providers.ts`). A field marked `env` is no prompt: it goes into the stored credential's settings,
 * which pi-ai reads the way it reads the environment (Azure's resource). `test/provider-forms.test.ts` runs every form
 * through pi-ai's own login, so a pi-ai that asks differently fails there, not in front of the owner.
 *
 * Plain data, shared with the web.
 */

export type FormField = {
	readonly id: string;
	readonly label: string;
	/** A secret is typed out of sight and never shown again. */
	readonly secret?: true;
	readonly placeholder?: string;
	/** Not a prompt: a setting kept with the credential under this name. */
	readonly env?: string;
	/** May be left empty. */
	readonly optional?: true;
};

export type FormMethod = {
	/** pi-ai's id for the method its login offers to choose; absent when it offers no choice. */
	readonly id?: string;
	readonly label: string;
	/** What this way needs, in the owner's words: where the credential lives, what banda keeps. */
	readonly note: string;
	readonly fields: readonly FormField[];
};

export type ProviderForm = {
	/** What this provider asks beyond a key, said once above the form. */
	readonly note: string;
	readonly methods: readonly FormMethod[];
};

const key = (label: string): FormField => ({ id: "key", label, secret: true, placeholder: "Paste it" });

export const PROVIDER_FORMS: { readonly [provider: string]: ProviderForm } = {
	"cloudflare-workers-ai": {
		note: "Workers AI runs under your Cloudflare account: banda needs an API token and the account's id.",
		methods: [
			{
				label: "API token",
				note: "Kept on the computer banda runs on, with the account id.",
				fields: [key("Cloudflare API token"), { id: "account", label: "Account ID", placeholder: "32 hex characters" }],
			},
		],
	},
	"cloudflare-ai-gateway": {
		note: "AI Gateway runs under your Cloudflare account: banda needs an API token, the account's id and the gateway's.",
		methods: [
			{
				label: "API token",
				note: "Kept on the computer banda runs on, with the account and gateway ids.",
				fields: [
					key("Cloudflare API token"),
					{ id: "account", label: "Account ID", placeholder: "32 hex characters" },
					{ id: "gateway", label: "Gateway ID" },
				],
			},
		],
	},
	"amazon-bedrock": {
		note: "Bedrock runs under your AWS account. Pick how banda signs its requests.",
		methods: [
			{
				id: "bearer-token",
				label: "Bedrock API key",
				note: "A Bedrock bearer token, kept on the computer banda runs on.",
				fields: [key("Bedrock API key")],
			},
			{
				id: "aws-profile",
				label: "AWS profile",
				note: "A profile from ~/.aws on the computer banda runs on: banda keeps its name, never its keys.",
				fields: [{ id: "profile", label: "Profile name", placeholder: "default" }],
			},
			{
				id: "credential-chain",
				label: "AWS credentials already set up",
				note: "Whatever AWS credentials the computer banda runs on has (environment, role, SSO). banda keeps nothing.",
				fields: [],
			},
		],
	},
	"google-vertex": {
		note: "Vertex AI runs in your Google Cloud project. Pick how banda signs its requests.",
		methods: [
			{
				id: "api-key",
				label: "Google Cloud API key",
				note: "Kept on the computer banda runs on.",
				fields: [key("Google Cloud API key")],
			},
			{
				id: "adc",
				label: "Application Default Credentials",
				note: "Run `gcloud auth application-default login` on the computer banda runs on first. banda keeps the project and location.",
				fields: [
					{ id: "project", label: "Project ID" },
					{ id: "location", label: "Location", placeholder: "us-central1" },
				],
			},
			{
				id: "service-account",
				label: "Service account file",
				note: "A credentials file on the computer banda runs on: banda keeps its path, never its contents.",
				fields: [
					{ id: "project", label: "Project ID" },
					{ id: "location", label: "Location", placeholder: "us-central1" },
					{ id: "file", label: "Credentials file path", placeholder: "/path/to/service-account.json" },
				],
			},
		],
	},
	azure: {
		note: "Azure OpenAI runs in your own Azure resource: banda needs its key and the resource. Each model's id is its deployment's name.",
		methods: [
			{
				label: "API key",
				note: "Kept on the computer banda runs on, with the resource.",
				fields: [
					key("Azure OpenAI key"),
					{ id: "resource", label: "Resource name", env: "AZURE_OPENAI_RESOURCE_NAME", optional: true },
					{
						id: "baseUrl",
						label: "Or its endpoint",
						env: "AZURE_OPENAI_BASE_URL",
						optional: true,
						placeholder: "https://my-resource.openai.azure.com/openai/v1",
					},
				],
			},
		],
	},
};

/** The answers to a form's prompts, in order, and its settings, from what the owner typed; or what is missing. */
export function answersOf(
	form: ProviderForm,
	methodId: string | undefined,
	values: { readonly [field: string]: unknown },
):
	| {
			readonly method: FormMethod;
			readonly answers: readonly string[];
			readonly env: Readonly<Record<string, string>>;
			readonly key?: string;
	  }
	| { readonly missing: string } {
	const method =
		methodId === undefined
			? form.methods[0]
			: form.methods.find((each) => each.id === methodId || each.label === methodId);
	if (method === undefined) return { missing: "Pick how to sign in" };
	const answers: string[] = [];
	const env: Record<string, string> = {};
	for (const field of method.fields) {
		const raw = values[field.id];
		const value = typeof raw === "string" ? raw.trim() : "";
		if (value === "" && field.optional !== true) return { missing: `${field.label} is needed` };
		if (field.env !== undefined) {
			if (value !== "") env[field.env] = value;
		} else answers.push(value);
	}
	if (method.fields.some((field) => field.env !== undefined) && Object.keys(env).length === 0)
		return {
			missing: `Give ${method.fields
				.filter((field) => field.env !== undefined)
				.map((field) => field.label.replace(/^Or /, "").toLowerCase())
				.join(" or ")}`,
		};
	const keyField = method.fields.find((field) => field.id === "key");
	const typed = keyField === undefined ? undefined : values[keyField.id];
	return {
		method,
		answers,
		env,
		...(typeof typed === "string" && typed.trim() !== "" ? { key: typed.trim() } : {}),
	};
}
