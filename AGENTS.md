# Working on banda (humans and agents)

Start with DESIGN.md (the ideas and the rules), docs/README.md (the section plans and delivery order),
docs/status.md (current work and acceptance) and the relevant section's open work.

## Principles
1. **One store.** pi-durable holds all truth; bytes too big for it live beside it as blobs, by hash, and the store holds
   every fact about them. Anything else is derived and rebuildable; a mechanism that only syncs
   two stores means one of them should not exist.
2. **Definitions are files.** Agents, routines, watches and memory are plain text files in the workspace, inspectable and
   editable by the owner or an agent; the store holds what runs and what was accepted, never a copy to sync. A connection
   is the exception: a definition banda ships and a choice the store holds, never a file in the workspace.
   Data is typed: a file that holds data, not prose, is `.json` with a TypeBox schema it is checked against on every
   read; `.md` only where free-form text is the point (instructions, personality, memory).
3. **Use the substrate first.** Before building, check whether pi-durable, pi-env, git or Docker already does it
   (exactly-once submits, durable sleeps, steering, child conversations).
4. **Boundaries are structural, not detective.** Trust comes from what is mounted, what is reachable and which
   process runs what; never from scanning after the fact.
5. **Data, not code, crosses the box boundary.** The daemon never executes or prompts with anything the box wrote
   until the owner accepted it.
6. **Spike every unknown before designing on it.** A DESIGN.md claim has evidence: a test, or a recorded manual run.
7. **One word per thing.** A rename is a design smell: fix the concept, then the word.
8. **Docs hold ideas and rules.** DESIGN.md never restates code and never records status or history; docs/status.md
   records current work and acceptance, and each section in docs/ owns its open work. Decision logs and caveats go
   in commit messages, not littered through docs and code.
9. **A slice is end to end.** A feature ships with its web UI and tests, so it can be tried and reviewed in the
   browser; the owner reviews each slice before the next starts. Nothing is done until it was used through the app
   against a running daemon (a throwaway home), as a person would, at desktop and phone width: the specimen and the
   tests do not count.
10. **Faults are injected, not imagined.** Every durable flow runs under `test/fault/`: thrown faults and SIGKILLs at
   its effect boundaries (commits, sends, model requests, and each new effect a slice adds as a fault point), as
   properties over generated scenarios plus a sweep of one kill at every boundary, checked by shared invariants.
11. **Review with severity.** A slice that touches trust or durability gets an adversarial review; findings are
   triaged (fix now / implementation note / dismiss), and only real ones change the design.
12. **Fix the cause, not the symptom.** When something breaks, find what in the design let it break and fix that,
   so the whole class of failure goes; never a patch that only makes the case at hand pass. A fix rests on a mechanism
   that holds whatever the provider, the platform or the timing does, and a test reproduces the cause before it
   changes.
13. **Pin exact versions; prefer no new dependency.** pi-durable, pi-ai, pi-env and chord move in lockstep.
14. **Measure performance on the code that ships.** A claim that something is faster or cheaper carries a number taken
   on the commit being shipped, with its baseline and sample size, in the commit message; an assumed cost is a hypothesis
   to run, not a fact to record. A change to what a provider is sent (prompt, tools, message order, request options)
   compares `npm run cache:audit` on a fork before and after, or `npm run cache:probe` where history cannot answer.

## Words
agent, band, group, chat, turn, queue, message, part, tool, wait, draft, permission, routine, watch, event, connection,
account, object, harness, session, artifact, memory, box, workspace, gateway, inference, device, as DESIGN.md defines them. One word per thing, in code, docs and the UI.

## Setup and checks
- Node 26, as `mise.toml` says (`mise install` gets it). `npm ci`, then `npm run check` (Biome: format and lint;
  `npm run fix` applies it), `npm run typecheck` and `npm test` (the fast ordinary suites). All green before every commit.
- Fast tests only locally: `npm test` and `npm run test:fast` run the ordinary suites without Docker tests or
  process-kill sweeps. During edits use `npm run test:fast -- <test-file>`. Do not run full/deep fault sweeps or
  Docker suites on development machines.
- Many runs share one machine, so a test owns what it uses: its temp home (each run has a temp folder of its own,
  removed after it), ports the system assigns at bind, Vite through `webServer` (test/helpers.ts), Chrome through
  `withPage` or `openChrome` (test/smoke/chrome.ts). What the machine has only so much of, or one of, is held through
  test/slots.ts: every file `npm test` runs waits for a slot before its clock starts (`BANDA_TEST_FILES`, `BANDA_TEST_BROWSERS`),
  and a fixed port a dependency binds gets a slot of its own. Wait on state with `until`, never read async UI once.
- Fault suites run nightly in CI; Docker suites run in CI on pushes to main. For an additional fault or Docker check,
  dispatch the `ci` workflow on the candidate ref. `npm run test:faults` and `npm run test:docker` are CI commands,
  not local pre-commit gates. Fault suites run one file at a time with at most two child jobs per runner.
- The web UI is in `web/`: `npm run build:web` builds what the daemon serves, `npm run web:dev` serves it with hot
  reload against a daemon on `BANDA_PORT`, `npm run web:contrast` audits the palette, and `#/specimen` shows every
  component, indexed by `web/src/specimen/registry.ts` (how to add or retire a section: `web/src/specimen/README.md`).
  A new component or variant joins the specimen.
- CI runs ordinary suites on every push to main and pull request, fault sweeps nightly at 02:17 UTC, and Docker
  suites on pushes to main. Manual CI runs select the fault and Docker suites. `node scripts/prebuild-images.ts`
  builds the box's images under the tags banda looks for (in CI through GitHub's layer cache).
- Releases: `npm run desktop:dev` opens the desktop app on a throwaway home; `npm run cli:pack` and
  `npm run desktop:pack` build this computer's release files into `release/`; a `v*` tag makes the release workflow
  draft a pre-release.
- The phone app is `mobile/`, Android only: the built web app in a Capacitor shell whose `Banda` plugin speaks the
  API over Iroh as a paired device. `npm run mobile:apk` builds a debug APK (the Android SDK at `ANDROID_HOME` or
  `~/Library/Android/sdk`; Gradle fetches the Java 21 it compiles with), `npm run mobile:install` installs and starts
  it on the running emulator or phone, `npm run mobile:test` runs the shell's own tests. Start an emulator with `-no-snapshot-save`; a `banda://pair` link given to
  `adb shell am start -a android.intent.action.VIEW -d '<link>' app.banda` stands in for the camera.
- Reach for a shadcn component (https://ui.shadcn.com/docs/components, added with `npx shadcn@latest add <name>` into
  `web/src/components/ui/`, on the Radix build `components.json` names, with any new dependency pinned exactly)
  before writing a primitive by hand: drawer and sheet for the phone, sonner for quiet confirmations, command for
  search, carousel for onboarding's options, and so on. They take banda's tokens, and each joins the specimen.
- Reach for an ai-elements component (https://elements.ai-sdk.dev, added into `web/src/components/ai-elements/` like
  the ones there) before writing one: `prompt-input` for the composer (voice included), `attachments` for files in
  the composer and in messages, `queue` for lists of work (an agent's routines and their runs), `web-preview` for an artifact rendered as a page,
  `persona` only for an agent's large animated face in voice mode (one at a time), and shadcn's
  `avatar` (already in `web/src/components/ui/`, its group and badge included) for every other face: an agent's
  emoji, a group's members, the people a draft involves. Two
  limits: `agent` (model, instructions, tool schemas) is a developer's view and appears only in Developer mode or
  a "details" disclosure, never on a consumer screen; `web-preview` renders untrusted content, so its iframe is
  sandboxed without `allow-same-origin` and never on the daemon's origin (it must not reach the token or the API),
  and its URL bar and console stay behind Developer mode.
- Properties take their run counts from `test/pbt.ts`: `BANDA_PBT_RUNS=20 npm test` multiplies the ordinary suites, and
  `BANDA_PBT_FAULT_RUNS` the fault-injection suites alone.
- Tests use temp homes and pi-ai's faux provider; they never need network, keys or a live service. Tests that need
  Docker skip when it is not available.

## Never touch a live banda
A banda daemon may be running from another checkout, possibly the one you are running inside of.
- The home is `~/.banda`. Never run `banda serve`, `say`, `approve`, `deny` or any write command against it.
- For a manual run use a throwaway home and port: `BANDA_HOME=$(mktemp -d) node dist/cli/index.js serve --port 7788`,
  then open the link it prints.
- A box outlives its daemon. When you are done with a throwaway home, stop its daemon and run `npm run boxes:sweep`
  (never while tests run: a test's box has no daemon). A test run sweeps the boxes of homes that are gone after it
  ends, and a daemon at start sweeps them too.
- To try the app with the owner's setup and conversations, fork the home instead of onboarding again:
  `npm run home:fork` copies the store (a consistent backup while its daemon runs), blobs, config, the owner's token,
  proxy credentials and the box's volumes into a temporary home, links the provider sign-in, and pauses routines there;
  then serve it as it prints, on a port of its own. It only reads the source home. `--browser` also copies signed-in
  sites.
- `npm run cache:audit -- --home <fork>` reports how a fork's real history used the prompt cache; `npm run cache:probe`
  sends invented text through a fork's sign-ins and spends real tokens, so it runs only when needed. Both refuse the live
  home. `test/cache-prefix.test.ts` guards the request's cached prefix offline.

## Changes
- Work lands on `main` as small commits; push and open pull requests only when the owner says so.
- Small commits with conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
- The commit message carries the why: what changed, the decisions taken and the caveats left (principle 8).
- A PR's proof is posted as one comment once checks, typecheck and tests are green: before (origin/main)
  and after (the branch), at desktop and phone width. Screenshots for a visual change; a GIF (ffmpeg, under
  8 MB) for an interaction. Record on a throwaway home with invented data and the faux provider, never
  a `home:fork`: the repo is public. Media go on the orphan branch `pr-proof` under `pr-<N>/` and are linked
  as `https://raw.githubusercontent.com/purrgrammer/banda/pr-proof/pr-<N>/<file>`.
- Push to GitHub only (`git push https://github.com/purrgrammer/banda <branch>`): `origin` also pushes to
  a nostr mirror that rejects force pushes.
- Pre-release: no backwards-compatibility layers. Change stored shapes in place, with no `migrate` and no version
  bump: a home made by an earlier build need not open, and the owner starts a fresh one. test/stored-shapes.test.ts
  covers the shapes as they are now.
