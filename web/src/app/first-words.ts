/** What an agent's empty chat starts with: who it is and what to try, broadly useful, none needing a connection. */
export const FIRST_STARTERS = [
	"Plan a long weekend somewhere warm next month",
	"Summarise today's tech news in five bullets",
	"Every weekday at 8:00, tell me the weather where I live",
] as const;

export const firstWords = (name: string) =>
	`Hi, I'm ${name}. Ask me anything: I can read the web, write, plan and keep track of things for you, and wake up on a schedule to check on something.`;
