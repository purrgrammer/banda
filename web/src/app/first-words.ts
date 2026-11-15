import { TOOLSETS } from "../../../src/core/toolsets.ts";

/**
 * What an agent's empty chat starts with: who it is and what to try, broadly useful, none needing a connection. Both
 * follow its tools (`tools`, as its file names them; undefined for the lead, which gets every tool), so an agent never
 * offers what it cannot do.
 */
const reachesWeb = (tools: readonly string[] | undefined) =>
	tools === undefined || tools.some((tool) => TOOLSETS.web?.includes(tool) || TOOLSETS.browser?.includes(tool));

export const firstStarters = (tools?: readonly string[]): readonly string[] => [
	"Plan a long weekend somewhere warm next month",
	...(reachesWeb(tools)
		? ["Summarise today's tech news in five bullets", "Every weekday at 8:00, tell me the weather where I live"]
		: ["Every weekday at 8:00, remind me what I planned for the day"]),
];

/**
 * Offered first while the agent still wears the default face: it designs one from its name and who it is, as a
 * candidate card in this chat for the owner to accept.
 */
export const FACE_STARTER = "Design yourself a face that fits your name";

export const firstWords = (name: string, tools?: readonly string[]) =>
	`Hi, I'm ${name}. Ask me anything: I can ${reachesWeb(tools) ? "read the web, " : ""}write, plan and keep track of ` +
	"things for you, and wake up on a schedule to check on something.";
