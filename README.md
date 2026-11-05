<p align="center"><img src="web/public/icon.svg" width="96" alt="Sancho, banda's first agent"></p>

<h1 align="center">banda</h1>

<p align="center">A band of AI agents that work for you, on your own machine.</p>

banda gives you a small team of AI agents. Sancho is the first; you add others, each with its own name, face,
personality and chat. They browse the web, research, write, make pages and documents, run on a schedule and use
services like GitHub. Each works inside a sandboxed computer of its own, and asks you before anything leaves it.

- **Yours.** Everything is stored on your machine. Pick any model provider and switch whenever you like.
- **Asks before it acts.** Reading is free; sending, posting or anything that can't be undone waits for your OK, shown
  as exactly what will happen.
- **Keeps your keys out of reach.** Tokens for your services never enter the agents' computer: they are added on the
  way out.
- **Keeps going.** Close the app or restart the computer, and the work picks up where it left off.

![A group chat: Mara finds the trains, Sancho plans the food, and Otto turns both into a printable itinerary](docs/screenshots/group.png)

| | |
|---|---|
| ![Sancho asks before opening a GitHub issue, showing exactly what will be sent](docs/screenshots/approval.png) | ![Sancho asks to set up a routine that runs every weekday at 8:00](docs/screenshots/routine.png) |
| **Asks before it writes:** the exact repository, title and text. | **Routines:** an agent wakes on a schedule and reports back. |
| ![Sancho's browser, live, reading Wikipedia's article on Porto](docs/screenshots/browser.png) | ![A printable comparison page Otto made from Mara's research](docs/screenshots/page.png) |
| **A browser of its own:** watch it, take over, or stop it. | **Pages and documents** to open, print and keep. |

> **Pre-release.** banda works, but it is young: expect rough edges and breaking changes, and run it on a machine you
> trust. Its sandbox is not yet hardened against hostile code or content ([what's open](docs/README.md)).

## Get started

You need **Docker** running (Docker Desktop on macOS, Docker Engine 25+ on Linux): each agent's computer is a
container. banda runs on macOS and Linux; Windows is untested.

**Desktop app or CLI:** download a pre-release from the [releases page](https://github.com/purrgrammer/banda/releases).
Builds are unsigned; each release's notes say how to open them.

**From source** (needs [Node 26](https://nodejs.org); `mise install` sets it up):

```sh
npm ci
npm run build
node dist/cli/index.js serve
```

Open the link it prints, pick a model provider and sign in. Anthropic, OpenAI, GitHub Copilot, OpenRouter, xAI and
Meta use your account; Google, Azure, Vertex AI, Amazon Bedrock, Mistral, DeepSeek, Groq and Cerebras take an API key.
The first start builds the agents' computer, which takes a few minutes.

Your data lives in `~/.banda`. Ctrl-C stops banda; the agents' containers stay, and `npm run boxes:sweep` removes those
of deleted homes. To start over, delete `~/.banda` and sweep.

## Contribute

```sh
npm run check && npm run typecheck && npm test
```

Start with [DESIGN.md](DESIGN.md) (how banda works and why) and [AGENTS.md](AGENTS.md) (how to work on it, by hand or
with an agent). [docs/](docs/README.md) holds the plan. Open an issue before a large change, and report security
issues privately as [SECURITY.md](SECURITY.md) says.

## License

[AGPL-3.0](LICENSE). Bundled third-party assets keep their own licenses: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
