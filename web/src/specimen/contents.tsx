/**
 * The page's contents: each group's components, in the order the registry lists their sections. A component renders one
 * or more sections; the registry test holds the two orders together.
 */
import type { ComponentType } from "react";
import { ActivitySection } from "./agent/activity.tsx";
import { AvatarCandidateSpecimen } from "./agent/avatar-candidate.tsx";
import { AvatarCreator } from "./agent/avatar-creator.tsx";
import { DevicesSection } from "./agent/devices.tsx";
import { MemorySection } from "./agent/memory.tsx";
import { PanelSections } from "./agent/panel.tsx";
import { SettingsSections } from "./agent/settings.tsx";
import { SkillsSection } from "./agent/skills.tsx";
import { ToolsetsSection } from "./agent/toolsets.tsx";
import { DoneSection } from "./chat/done.tsx";
import { Parts } from "./chat/parts.tsx";
import { CalendarSection } from "./connections/calendar.tsx";
import { ConnectSections } from "./connections/connect.tsx";
import { ContactsSection } from "./connections/contacts.tsx";
import { ConnectionDetailsSection } from "./connections/details.tsx";
import { DriveSection } from "./connections/drive.tsx";
import { GithubSection } from "./connections/github.tsx";
import { GmailSection } from "./connections/gmail.tsx";
import { McpSection } from "./connections/mcp.tsx";
import { AppIcon } from "./explorations/app-icon.tsx";
import { Controls } from "./foundation/controls.tsx";
import { Copy } from "./foundation/copy.tsx";
import { Faces } from "./foundation/faces.tsx";
import { Foundation } from "./foundation/foundation.tsx";
import { HarnessSection } from "./harness/harness.tsx";
import type { GroupId } from "./registry.ts";
import { BandSection } from "./screens/band.tsx";
import { Screens } from "./screens/screens.tsx";
import { States } from "./states/states.tsx";

/** The components of each group, in page order, each named by its file. */
export const CONTENTS: Readonly<Record<GroupId, readonly (readonly [string, ComponentType])[]>> = {
	foundation: [
		["foundation", Foundation],
		["faces", Faces],
		["controls", Controls],
		["copy", Copy],
	],
	chat: [
		["parts", Parts],
		["done", DoneSection],
	],
	screens: [
		["screens", Screens],
		["band", BandSection],
	],
	agent: [
		["panel", PanelSections],
		["avatar-creator", AvatarCreator],
		["avatar-candidate", AvatarCandidateSpecimen],
		["memory", MemorySection],
		["skills", SkillsSection],
		["toolsets", ToolsetsSection],
		["activity", ActivitySection],
		["settings", SettingsSections],
		["devices", DevicesSection],
	],
	connections: [
		["connect", ConnectSections],
		["connection-details", ConnectionDetailsSection],
		["github", GithubSection],
		["gmail", GmailSection],
		["calendar", CalendarSection],
		["contacts", ContactsSection],
		["drive", DriveSection],
		["mcp", McpSection],
	],
	harness: [["harness", HarnessSection]],
	states: [["states", States]],
	explorations: [["app-icon", AppIcon]],
};
