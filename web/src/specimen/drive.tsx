/** Google Drive's file cards: a Doc, a Sheet, Slides, a PDF, a folder, an image, and a very long name. */
import { Bubble } from "../chat/Feed.tsx";
import { type DriveFile, FileCard, ObjectLink } from "../chat/Object.tsx";
import { Section } from "./stage.tsx";

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

export function DriveSection() {
	return (
		<Section
			id="drive"
			title="Google Drive"
			note="Files an agent names, drawn from banda's own reading. Read-only: nothing here changes, moves or shares a file."
		>
			<div className="grid gap-6 lg:grid-cols-2">
				{FILES.map(([label, file]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<FileCard file={file} />
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
