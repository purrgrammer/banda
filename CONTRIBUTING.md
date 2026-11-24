# Contributing

The path from a fork to a pull request, for anyone, with or without write access to this repository.
[AGENTS.md](AGENTS.md) says how to work on banda (principles, words, checks); read it first.

## Before you start
- A small fix or a change of words: open a pull request. Anything larger, and any change to core
  ([Checks by change](AGENTS.md#checks-by-change)): open an issue first and wait for an answer. [docs/](docs/README.md)
  holds the plan.
- A security issue goes privately, as [SECURITY.md](SECURITY.md) says: never in an issue or a pull request.
- You contribute under the project's license, [AGPL-3.0](LICENSE).

## Set up safely
Working on banda needs no keys, accounts or real data.
- Node 26 (`mise install`), then `npm ci`.
- `npm run check`, `npm run typecheck`, `npm test`: temp homes and a fake model, no network or keys. While editing,
  `npm run test:fast -- <file>`. `test:faults`, `test:computer` and `test:docker` run in CI, not on your machine.
- A banda daemon, as it starts (some tests start one), and `npm run boxes:sweep` remove what the computers of homes they
  cannot find on this disk left behind: as this OS user, and on the Docker engine this shell reaches. So work as an OS
  user, and against a Docker engine, where every banda home is yours and on a disk mounted now: never a Docker engine
  others share (check `docker context show` and `DOCKER_HOST`). To see which homes they hold computers for, without
  changing anything:
  ```sh
  docker ps --all --filter label=banda.home --format '{{.Label "banda.home"}}' | sort -u
  cat /private/tmp/banda-msb-$(id -u)-*/home.json   # on Linux: /tmp/banda-msb-…
  ```
  Each path should be a home of yours on this computer, or one you are done with.
- To try the app: `npm run build`, then `BANDA_HOME=$(mktemp -d) node dist/cli/index.js serve --port 7788`, and open
  the link it prints. It needs a model: one on your own computer ([README](README.md#get-started)) or your own
  provider account. Invent every piece of data you give it. Never point it at your `~/.banda`, and never use
  `npm run home:fork` for a contribution.
- Done: Ctrl-C, delete the temp home, then `npm run boxes:sweep` (on the setup above, and never while tests run).

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
