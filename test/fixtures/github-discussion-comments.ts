/**
 * `get_discussion_comments` as two github-mcp-server builds really answered it, for github/github-mcp-server
 * discussion #1257 (`perPage: 30, includeReplies: true`), recorded on 2026-11-12 with a read-only token: the answer's
 * text, parsed. Trimmed: six of the page's thirty comments (positions 0, 1, 2, 3, 7 and 8), each body cut to its first
 * words; ids, authors, replies, counts, the page and the order of keys are as recorded. Comments 0, 1 and 3 were
 * written by accounts since deleted: GitHub's GraphQL API answers their author as null.
 */

/**
 * GitHub's hosted server (https://api.githubcopilot.com/mcp/, serverInfo.version
 * "github-mcp-server/remote-68225c700c377ed8a257d4d633c895c01356df3c"), the one banda ships: no comment names its author.
 */
export const HOSTED_DISCUSSION_COMMENTS = {
	comments: [
		{
			id: "DC_kwDOODGMVM4A4fTc",
			body: "39 days, no response.\r\n\r\n  claude-faf-mcp is…",
		},
		{
			id: "DC_kwDOODGMVM4A4qSR",
			body: "🎉 **Update: Additional Milestone Since…",
		},
		{
			id: "DC_kwDOODGMVM4A47zL",
			body: "Hey @Wolfe-Jam, \r\nright now the GitHub MCP…",
		},
		{
			id: "DC_kwDOODGMVM4A48iA",
			body: "Hey HolgerMany thanks for your reply, we will…",
		},
		{
			id: "DC_kwDOODGMVM4BAwxx",
			body: "Hi @Wolfe-Jam, thanks for the thoughtful…",
			isAnswer: true,
			replies: [
				{
					id: "DC_kwDOODGMVM4BCgL5",
					body: "Hi @trent-j \r\n\r\nCould you please provide the…",
				},
			],
			replyTotalCount: 1,
		},
		{
			id: "DC_kwDOODGMVM4BCj5v",
			body: "Hey @trent-j — thanks again for looking into…",
			replies: [
				{
					id: "DC_kwDOODGMVM4BCtUW",
					body: "We really appreciate your interest and the…",
				},
				{
					id: "DC_kwDOODGMVM4BCtcF",
					body: "Wow! what amazing news, thank you for your…",
				},
				{
					id: "DC_kwDOODGMVM4BDG1p",
					body: "Thanks again, trent-j 🙏 — two more of the FAF…",
				},
			],
			replyTotalCount: 3,
		},
	],
	pageInfo: {
		endCursor: "Y3Vyc29yOnYyOpK0MjAyNi0wOS0wOVQxOTozMzo1N1rOARhfOg==",
		hasNextPage: true,
		hasPreviousPage: false,
		startCursor: "Y3Vyc29yOnYyOpK0MjAyNS0xMC0yOFQyMToxOTozOVrOAOH03A==",
	},
	totalCount: 575,
};

/**
 * github-mcp-server built from upstream main (6fbcd00) with the change that adds `author { login }` to comments and
 * replies (MinimalDiscussionComment.Author), run locally in stdio mode (serverInfo.version
 * "vcs-5f0f08beb0823d8b70779c575d925b56ebbac2df"): a comment by a deleted account has no `author`. Not released.
 */
export const PATCHED_DISCUSSION_COMMENTS = {
	comments: [
		{
			id: "DC_kwDOODGMVM4A4fTc",
			body: "39 days, no response.\r\n\r\n  claude-faf-mcp is…",
		},
		{
			id: "DC_kwDOODGMVM4A4qSR",
			body: "🎉 **Update: Additional Milestone Since…",
		},
		{
			id: "DC_kwDOODGMVM4A47zL",
			body: "Hey @Wolfe-Jam, \r\nright now the GitHub MCP…",
			author: {
				login: "hstaudacher",
			},
		},
		{
			id: "DC_kwDOODGMVM4A48iA",
			body: "Hey HolgerMany thanks for your reply, we will…",
		},
		{
			id: "DC_kwDOODGMVM4BAwxx",
			body: "Hi @Wolfe-Jam, thanks for the thoughtful…",
			isAnswer: true,
			author: {
				login: "trent-j",
			},
			replies: [
				{
					id: "DC_kwDOODGMVM4BCgL5",
					body: "Hi @trent-j \r\n\r\nCould you please provide the…",
					author: {
						login: "cx-anand-nandeshwar",
					},
				},
			],
			replyTotalCount: 1,
		},
		{
			id: "DC_kwDOODGMVM4BCj5v",
			body: "Hey @trent-j — thanks again for looking into…",
			author: {
				login: "Wolfe-Jam",
			},
			replies: [
				{
					id: "DC_kwDOODGMVM4BCtUW",
					body: "We really appreciate your interest and the…",
					author: {
						login: "trent-j",
					},
				},
				{
					id: "DC_kwDOODGMVM4BCtcF",
					body: "Wow! what amazing news, thank you for your…",
					author: {
						login: "Wolfe-Jam",
					},
				},
				{
					id: "DC_kwDOODGMVM4BDG1p",
					body: "Thanks again, trent-j 🙏 — two more of the FAF…",
					author: {
						login: "Wolfe-Jam",
					},
				},
			],
			replyTotalCount: 3,
		},
	],
	pageInfo: {
		endCursor: "Y3Vyc29yOnYyOpK0MjAyNi0wOS0wOVQxOTozMzo1N1rOARhfOg==",
		hasNextPage: true,
		hasPreviousPage: false,
		startCursor: "Y3Vyc29yOnYyOpK0MjAyNS0xMC0yOFQyMToxOTozOVrOAOH03A==",
	},
	totalCount: 575,
};
