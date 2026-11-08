/** Google Drive's file cards: a Doc, a Sheet, Slides, a PDF, a folder, an image, and a very long name. */
import { DraftApproval } from "../../app/DraftApproval.tsx";
import { Bubble } from "../../chat/Feed.tsx";
import { type DriveFile, FileCard, ObjectLink } from "../../chat/Object.tsx";
import { Section } from "../stage.tsx";

const PLAN: DriveFile = {
	name: "Q1 rollout plan",
	kind: "doc",
	mimeType: "application/vnd.google-apps.document",
	owner: "Ana García",
	modified: "2026-11-05T16:42:10.000Z",
	size: null,
	description: "Dates, owners and the order teams move in. Read before the planning call.",
	url: "https://docs.google.com/document/d/1aBcD_eFgH-ijk/edit",
};

export const FILES: readonly (readonly [string, DriveFile])[] = [
	["A Google Doc with a description", PLAN],
	[
		"A Google Sheet",
		{
			...PLAN,
			name: "Budget 2027",
			kind: "sheet",
			mimeType: "application/vnd.google-apps.spreadsheet",
			owner: "Teo",
			modified: "2026-10-28T09:15:00.000Z",
			description: "",
			url: "https://docs.google.com/spreadsheets/d/1sHeEt/edit",
		},
	],
	[
		"A PDF, with its size",
		{
			...PLAN,
			name: "Signed contract - Northstar.pdf",
			kind: "pdf",
			mimeType: "application/pdf",
			owner: "Mira",
			modified: "2025-03-14T12:00:00.000Z",
			size: 2_457_600,
			description: "",
			url: "https://drive.google.com/file/d/1pDf/view",
		},
	],
	[
		"A folder",
		{
			...PLAN,
			name: "Northstar",
			kind: "folder",
			mimeType: "application/vnd.google-apps.folder",
			owner: "Ana García",
			description: "",
			url: "https://drive.google.com/drive/folders/1fOlDeR",
		},
	],
	[
		"Slides, shared without a page to open",
		{
			...PLAN,
			name: "All hands, November",
			kind: "slides",
			mimeType: "application/vnd.google-apps.presentation",
			description: "",
			url: undefined,
		},
	],
	[
		"A very long name, a binary of its own type",
		{
			...PLAN,
			name: "Final_final_v12_export_from_the_old_accounting_system_with_every_quarter_since_2019_DO_NOT_EDIT_(copy)_(2).xlsx.zip",
			kind: "file",
			mimeType: "application/zip",
			owner: "An owner with a very long display name from another organisation",
			size: 734_003,
			description: "",
			url: "https://drive.google.com/file/d/1zIp/view",
		},
	],
];

type Draft = Parameters<typeof DraftApproval>[0]["ask"];
const AS = "alice@example.test on Google Drive";
const ON = { refs: ["drive:file:MWFCY0RfZUZnSC1pams"], account: "alice" };
const NOTES =
	"# Q1 rollout\n\n## Order\n1. Platform\n2. Payments\n3. Growth\n\nOwners are listed below.\nAna: platform\nTeo: payments\nBo: growth";

/** A draft of each change, as the daemon words them: no field is edited, the owner approves what was drafted. */
const DRAFTS: readonly (readonly [string, Draft, string, boolean])[] = [
	[
		"Draft: create a Doc",
		{
			type: "approval",
			tool: "drive__create_doc",
			verb: "Create",
			as: AS,
			args: { title: "Q1 plan", markdown: NOTES, account: "alice" },
		},
		"Create the Doc “Q1 plan”",
		false,
	],
	[
		"Draft: create a Sheet",
		{
			type: "approval",
			tool: "drive__create_sheet",
			verb: "Create",
			as: AS,
			args: { title: "Budget", csv: "Team,Q1,Q2\nPlatform,120,140\nPayments,90,95", account: "alice" },
		},
		"Create the Sheet “Budget”",
		false,
	],
	[
		"Draft: replace a Doc's text",
		{
			type: "approval",
			tool: "drive__replace_doc_text",
			verb: "Replace",
			as: AS,
			on: ON,
			args: { file_id: "1aBcD_eFgH-ijk", markdown: NOTES, account: "alice" },
		},
		"Replace the text of this Doc",
		true,
	],
	[
		"Draft: rename",
		{
			type: "approval",
			tool: "drive__rename_file",
			verb: "Rename",
			as: AS,
			on: ON,
			args: { file_id: "1aBcD_eFgH-ijk", name: "Q1 rollout plan (final)", account: "alice" },
		},
		"Rename this file to “Q1 rollout plan (final)”",
		true,
	],
	[
		"Draft: trash",
		{
			type: "approval",
			tool: "drive__trash_file",
			verb: "Trash",
			as: AS,
			on: ON,
			args: { file_id: "1aBcD_eFgH-ijk", account: "alice" },
		},
		"Move this file to the trash",
		true,
	],
	[
		"Draft: add rows to a tab",
		{
			type: "approval",
			tool: "drive__append_rows",
			verb: "Add",
			as: AS,
			on: ON,
			args: {
				file_id: "1sHeEt",
				sheet: "ops",
				rows: '2026-11-08,MSFT,BUY - MARKET,2,$530.61,"$1,061.22",USD,1.1552',
				account: "alice",
			},
		},
		"Add a row to the tab “ops” of this Sheet",
		true,
	],
	[
		"Draft: write cells",
		{
			type: "approval",
			tool: "drive__update_range",
			verb: "Write",
			as: AS,
			on: ON,
			args: { file_id: "1sHeEt", range: "'Budget 2027'!G4", rows: "95", account: "alice" },
		},
		"Write “'Budget 2027'!G4” of this Sheet",
		true,
	],
	[
		"Draft: add a tab",
		{
			type: "approval",
			tool: "drive__add_sheet",
			verb: "Add",
			as: AS,
			on: ON,
			args: { file_id: "1sHeEt", title: "2028", account: "alice" },
		},
		"Add the tab “2028” to this Sheet",
		true,
	],
];

export function DriveSection() {
	return (
		<Section id="drive" note="Files an agent names, as cards; an agent's change is a draft you approve as drafted.">
			<div className="grid gap-6 lg:grid-cols-2">
				{FILES.map(([label, file]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<FileCard file={file} />
					</div>
				))}
				{DRAFTS.map(([label, ask, words, drawn]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<DraftApproval
							chat={0}
							agent={{ name: "Iris" }}
							label={words}
							ask={ask}
							wait={`specimen-${label}`}
							drawn={drawn ? <FileCard file={PLAN} /> : undefined}
						/>
					</div>
				))}
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Named in a message</span>
					<Bubble mine>
						Summarise <ObjectLink object={{ ...PLAN, card: "file" }} href={PLAN.url ?? ""} /> for the call
					</Bubble>
				</div>
			</div>
		</Section>
	);
}
