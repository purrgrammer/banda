# banda

A band of personal agents. One default agent is where the app opens; you add agents of
your own, each with its own chat, skills and permissions. They research, write, keep track of things and work with your
services inside a computer of their own, keep working while you are away, and ask before anything consequential leaves
that computer. You work with them through one app (web, and installed on your phone or desktop) and a small CLI.

- **Sovereign.** One store on your machine holds everything; the model provider is a swappable choice.
- **Private by structure.** Credentials never enter the computer the agent's code runs in: a proxy adds them on the way
  out. Untrusted content, your data and an outbound send never meet without you.
- **Safe by consequence.** You are asked only about what cannot be undone or sends data out, shown as the exact thing
  that will happen.
- **Durable.** A crash, a restart or a week offline loses nothing and does nothing twice.

![A group chat: Mara finds the trains, Sancho plans the food, and Otto turns both into a printable itinerary](docs/screenshots/group.png)

| | |
|---|---|
| ![Sancho asks before opening a GitHub issue, showing exactly what will be sent](docs/screenshots/approval.png) | ![Sancho asks to set up a routine that runs every weekday at 8:00](docs/screenshots/routine.png) |
| **Asks before it writes.** A write is a card with the exact repository, title and text. | **Routines.** An agent wakes on a schedule and reports what it finds. |
| ![Sancho's browser, live, reading Wikipedia's article on Porto](docs/screenshots/browser.png) | ![A printable comparison page Otto made from Mara's research](docs/screenshots/page.png) |
| **A browser of its own.** Watch it work, take over, or stop it. | **Artifacts.** Pages and documents you open, print and keep. |

> **Status: pre-release.** banda is under active development and not yet production-ready: the isolation, egress and
> recovery work tracked in [docs/README.md](docs/README.md) is still open. Run it for yourself, on a machine you trust,
> and expect stored shapes to change without migrations.

## Run it

banda runs on macOS and Linux; Windows is untested. You need [Node 26](https://nodejs.org) (`mise install` reads
[mise.toml](mise.toml)) and Docker Engine 25 or later (Docker Desktop on macOS, Docker Engine on Linux): the agent's
computer is a container behind its own network. The first `serve` builds that computer's image, which takes several
minutes.

```sh
npm ci
npm run build
node dist/cli/index.js serve
```

Open the link it prints, pick a model provider and sign in. Anthropic, OpenAI, GitHub Copilot, OpenRouter, xAI and
Meta sign in with your account; Google, Azure, Vertex AI, Amazon Bedrock, Mistral, DeepSeek, Groq and Cerebras take a
key. Your home is `~/.banda` (`--home <dir>` or `BANDA_HOME` for another); `node dist/cli/index.js --help` lists the
CLI.

### Stop and clean up

Ctrl-C stops the daemon. The agent's computer is a container that outlives it; `npm run boxes:sweep` removes the
containers, networks and volumes of homes that are gone. To start over, delete `~/.banda`, then sweep.

## Develop

```sh
npm run check && npm run typecheck && npm test
```

`npm run web:dev` serves the app with hot reload against a running daemon, and `#/specimen` shows every component. Read
[DESIGN.md](DESIGN.md) for the ideas and the rules, [AGENTS.md](AGENTS.md) for how to work on it (by hand or with an
agent). [docs/README.md](docs/README.md) has what is planned, and [docs/status.md](docs/status.md) the maintainer's
working notes. Report security issues as [SECURITY.md](SECURITY.md) says.

Contributions are welcome: read [AGENTS.md](AGENTS.md), which applies to people and agents alike, and open an issue
before a large change.

## License

[AGPL-3.0](LICENSE). Bundled third-party assets keep their own licenses: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
