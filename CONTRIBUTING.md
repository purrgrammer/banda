# Contributing

The path from a fork to a pull request, for anyone, with or without write access to this repository.
[AGENTS.md](AGENTS.md) says how to work on banda (principles, words, checks); read it first.

## Before you start
- A small fix or a change of words: open a pull request. Anything larger, and any change to core
  ([Checks by change](AGENTS.md#checks-by-change)): open an issue first and wait for an answer. [docs/](docs/README.md)
  holds the plan.
- A security issue goes privately, as [SECURITY.md](SECURITY.md) says: never in an issue or a pull request.

## Set up safely
Working on banda needs no keys, accounts or real data.
- Node 26 (`mise install`), then `npm ci`.
- `npm run check`, `npm run typecheck`, `npm test`: temp homes and a fake model, no network or keys. A test run removes
  afterwards only the boxes its own tests left. While editing, `npm run test:fast -- <file>`. `test:faults`,
  `test:computer` and `test:docker` run in CI, not on your machine.
- To try the app: `npm run build`, then `BANDA_HOME=$(mktemp -d) node dist/cli/index.js serve --port 7788`, and open
  the link it prints. It needs a model: one on your own computer ([README](README.md#get-started)) or your own
  provider account. Invent every piece of data you give it. Never point it at your `~/.banda`, and never use
  `npm run home:fork` for a contribution.
- Done: Ctrl-C, then delete the temp home. Whatever computer it made stays behind (a cache in the temporary folder,
  or with `--box container` a container with its networks and volumes): banda removes no box as it starts.
  `npm run boxes:sweep` is no step of this path: it removes the boxes of every home it cannot find, others' included.

## Open a pull request from your fork
1. Fork, branch from `main`, small commits prefixed `feat:`, `fix:`, `docs:`, `refactor:` or `test:`; each message
   says why.
2. Run the checks your change calls for: [Checks by change](AGENTS.md#checks-by-change) sets them by what the change
   can break, not by its size. CI runs the ordinary checks (`check`, `typecheck`, `test:fast`, `build`) on every
   pull request.
3. In the description: what and why, the issue, which kind of change it is, the commands you ran with their result,
   and what you did not or could not run. A suite that skipped is reported as skipped, never as passed.
4. Proof, as the kind of change asks: a test that fails before and passes after for a change in behaviour;
   before/after screenshots at desktop and phone width only when something visible changes (a GIF for an
   interaction), attached to the description or a comment. If you could not run a model, say so.
5. Never attach or paste a token, a pairing link or code, anything from a real home, or a log or transcript of one.
6. The maintainer reviews, may ask for changes, runs the CI checks only they can start (fault and box suites), and
   merges.
