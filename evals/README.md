# Product journey evals

These reusable checklists exercise banda's app journeys against a real daemon. They complement the benchmark
research in [docs/evals.md](../docs/evals.md) and the deterministic/fault gates in
[docs/verification.md](../docs/verification.md). Sending a prompt is setup, **not UX acceptance**: use the app at
1440×900 and 390×844, perform the actions, and record observable evidence at each width. Missing checks stay pending;
unsupported features or unavailable prerequisites are blocked, never passed.

Use Node 26 and install/build the checkout (`npm ci`, `npm run build`). No additional dependency is required.

## Fresh instance

```sh
npm run eval:journeys -- fresh
```

This starts a unique throwaway home on an OS-assigned port and waits until Ctrl-C. It does not use `BANDA_HOME`,
copy credentials, or read the live home's provider configuration. Open the private link in the printed
`open-app.txt` file, then connect a disposable provider in the app. The link contains the test instance's owner
credential: do not paste it into reports. The home is retained after exit so it can be inspected or restarted
explicitly with `node dist/cli/index.js serve --home <printed-test-home> --port 0`.

The real daemon requires its normal runtime prerequisites; fresh does not create a fake provider or bypass the box.
The child inherits only PATH, HOME and Docker connection settings to reach the installed runtime; provider-key
environment variables are not forwarded. Private `daemon.log` diagnostics may contain the test app credential, so
do not attach that file to reports without sanitizing it. A missing box/provider is a blocked prerequisite for dependent steps, not a successful behavioral run.

## Pick and start a journey

```sh
npm run eval:journeys -- list
npm run eval:journeys -- show first-use
npm run eval:journeys -- start first-use --home /path/to/printed-test-home
```

`start` prints a private run-file path. It sends nothing. `--out /path/to/new-run.json` chooses the file explicitly;
an existing file is refused. Each run uses a new conversation thread, so sending prompts does not steer existing
work. For first-use's main-conversation check, type its prompt into Home yourself; the send helper intentionally
uses an isolated conversation. A new thread does **not** isolate memory, services or workspace: use a fresh home
for a clean experiment and disposable data/services when using an existing test instance.

An existing test daemon can instead be selected by explicit loopback origin:

```sh
# Set BANDA_EVAL_TOKEN privately in your environment; do not put credentials in arguments or shell history.
npm run eval:journeys -- start holiday --url http://127.0.0.1:12345
```

Only loopback HTTP origins with an explicit port are accepted. URL credentials, fragments, queries, paths and
redirects are rejected. The live `~/.banda` home (including symlinks) and its recorded daemon port are refused.
Use the home option where possible: its current token is loaded privately when sending. URL targets require
`BANDA_EVAL_TOKEN` again for each send. Existing-instance actions can change that test instance and spend provider
credits; review the prompts and prerequisites before submitting.

## Send one input, then inspect the app

```sh
npm run eval:journeys -- show holiday
npm run eval:journeys -- send /path/to/run.json plan
```

Only the selected step's prompt is sent, through the same idempotent `/api/messages` endpoint as the app. Evaluator
checkpoints are never included. The command prints a token-free conversation link; open the authenticated app first.
An uncertain network response retains the message ID for retry. A known successful submission cannot be resent from
the same run. Later prompt steps continue the same test conversation; send them only when their action calls for it.

UI-only actions have no sendable prompt. Perform approvals, edits, pause, takeover, provider setup and recovery in
the app. No command approves a send, accepts a capability or injects a fault automatically. Uncertain-send and
browser tests require controlled service/fault fixtures; record blocked when those prerequisites are absent. Never
substitute a real purchase, recipient or account for a stand-in.

## Record and report

```sh
npm run eval:journeys -- record /path/to/run.json plan --width desktop --verdict pass --note '1440×900: request answered, task status visible, no project wizard; screenshot stored locally at …'
npm run eval:journeys -- record /path/to/run.json plan --width phone --verdict fail --note '390×844: task controls overflow; keyboard cannot reach Stop.'
npm run eval:journeys -- report /path/to/run.json
```

Verdicts are `pass`, `fail` or `blocked`. A pass for a step means **all its checkpoints** were observed at that width.
Include the outcome, relevant failure/recovery behavior and a local screenshot/trace reference in the note. Notes
must be sanitized: no owner tokens, provider keys, personal information or service credentials. Reports store only
selected prompts, submission receipts and evaluator evidence; daemon responses and auth tokens are not copied.
The run file is owner-readable only. It pins the journey definition hash, refusing reuse when the checklist changes.

A run passes only when every step has a passing observation at both widths. Reports show denominators and pending,
failed and blocked counts, not an invented intelligence score. Evidence is evaluator-authored; the runner does not
verify screenshots or assert that an app action happened. Owner review and the repository's other acceptance gates
remain separate requirements.

## Journey coverage

| ID | Coverage |
|---|---|
| `first-use` | Provider setup/recovery, useful first answer, identity, progressive navigation |
| `work` | Delegation, steering, stop, progress, return and history |
| `artifacts` | First artifact, Library disclosure, editing, concurrency, versions, restoration, removal |
| `decisions` | Questions, Inbox consistency, exact drafts, approval/decline, revocation, uncertain effects |
| `routines-goals` | Goal/routine review, schedules, return visits, pause and completion |
| `agents-memory` | New conversations, specialists, memory correction/deletion, groups, lifecycle |
| `browser` | Inline browser, takeover, sign-in, give-back, supported sends, sign-out |
| `holiday` | Cross-feature holiday planning, correction, calendar, itinerary, reminder and recovery |

Edit `journeys.ts` to extend a journey: keep owner inputs separate from evaluator checkpoints, state prerequisites,
and include a failure/recovery path. Use published benchmarks for general agent-quality claims; these banda-specific
journeys address app behavior those benchmarks do not measure.
