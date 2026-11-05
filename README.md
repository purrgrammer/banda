# banda

A team of personal agents you run on your own machine. One default agent is where the app opens; you add agents of
your own, each with its own chat, skills and permissions. They research, write, keep track of things and work with your
services inside a computer of their own, keep working while you are away, and ask before anything consequential leaves
that computer. You work with them through one app (web, and installed on your phone or desktop) and a small CLI.

- **Sovereign.** One store on your machine holds everything; the model provider is a swappable choice, local models
  included.
- **Private by structure.** Credentials never enter the computer the agent's code runs in: a proxy adds them on the way
  out. Untrusted content, your data and an outbound send never meet without you.
- **Safe by consequence.** You are asked only about what cannot be undone or sends data out, shown as the exact thing
  that will happen.
- **Durable.** A crash, a restart or a week offline loses nothing and does nothing twice.

> **Status: pre-release.** banda is under active development and not yet production-ready: the isolation, egress and
> recovery work tracked in [docs/README.md](docs/README.md) is still open. Run it for yourself, on a machine you trust,
> and expect stored shapes to change without migrations.

## Run it

You need [Node 26](https://nodejs.org) (`mise install` reads [mise.toml](mise.toml)) and Docker (or Podman's docker):
the agent's computer is a container behind its own network.

```sh
npm ci
npm run build
node dist/cli/index.js serve
```

Open the link it prints, pick a model provider and sign in. Your home is `~/.banda` (`--home <dir>` or
`BANDA_HOME` for another); `node dist/cli/index.js --help` lists the CLI.

## Develop

```sh
npm run check && npm run typecheck && npm test
```

`npm run web:dev` serves the app with hot reload against a running daemon, and `#/specimen` shows every component. Read
[DESIGN.md](DESIGN.md) for the ideas and the rules, [AGENTS.md](AGENTS.md) for how to work on it (by hand or with an
agent), and [docs/status.md](docs/status.md) for what is in progress. Report security issues as
[SECURITY.md](SECURITY.md) says.

## License

[AGPL-3.0](LICENSE). Bundled third-party assets keep their own licenses: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
