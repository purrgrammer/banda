# Multimodality

banda should route each operation to a model that can perform it. Quick, Balanced and Deep remain the owner's
choice of reasoning depth; transcription, spoken replies, image creation and search have their own provider and
model choices. The owner talks to an agent in one chat, switching between text, images and voice without
having to choose a model for each message.

This is a proposal, not an implemented contract. The research below was checked on November 2, 2026 against the
repository, its installed pi-ai 1.4.0 catalog and official OpenAI documentation. Catalog inspection establishes
adapter support, not account entitlement or successful requests. No live banda home or credentials were inspected.

## Starting point

| Capability | What exists |
|---|---|
| Reasoning | Quick/Balanced/Deep presets; provider selection; per-tier overrides; agent files that pin a model; the owner switches a chat's tier |
| Image understanding | Uploaded images are prepared and included in model input; the installed Codex models advertise text and image input |
| Media storage | Attachments and content-addressed blobs; artifacts with versions |
| Speech | No recording, transcription, synthesis or live voice integration found |
| Retrieval | SQLite FTS5 over memory and chat messages; no embeddings |
| Image generation | pi-ai has image model types and `generateImages()`, but banda does not call it; the installed OpenAI and Codex providers do not implement that hook |
| Discovery | The tier API exposes model IDs and names, without operation or modality metadata |

Relevant code: [tiers](../src/core/tiers.ts), [tier API](../src/server/routes/tiers.ts),
[agents](../src/core/agents.ts), [image intake](../src/daemon.ts), [search](../src/core/search.ts),
[composer](../web/src/chat/Composer.tsx), [provider connections](../src/server/routes/providers.ts).
The app's provider connection list explicitly excludes `openai-codex`; CLI provider login exists.

## Subscription access and API access

Subscription features, a provider's catalog and a callable adapter are separate facts. A feature available in
Codex does not establish an endpoint banda can call with Codex credentials.

| Reasoning model | Official subscription documentation | Installed Codex catalog |
|---|---|---|
| `gpt-6-luna` | Current efficient model | Present; Quick preset |
| `gpt-6.1-sol` | Current general model | Present; Balanced preset |
| `gpt-6-astra` | Current most capable model | Present; Deep preset |
| `gpt-6.1-terra` | Current writing, vision and computer-use model | Absent |
| `gpt-6-sol` | Listed in subscription usage tables | Present |

Availability varies by plan, client, workspace settings and rollout. The installed catalog also lists
`gpt-5.6-luna`, `gpt-5.6-sol` and `gpt-5.6-terra`; their presence does not prove current subscription access.
GPT-5.5 retired from Codex with ChatGPT sign-in on October 14, 2026; API access is separate.
Sources: [models](https://learn.chatgpt.com/docs/models), [pricing](https://learn.chatgpt.com/docs/pricing).

Codex's built-in image generation uses `gpt-image-2` and consumes its general usage allowance. Desktop voice uses
GPT-Live and consumes subscription usage too. Neither feature is exposed by banda's installed Codex adapter.
The documentation checked establishes no subscription embedding endpoint for banda.
Sources: [image generation](https://learn.chatgpt.com/docs/image-generation),
[voice usage](https://learn.chatgpt.com/docs/pricing).

Eligible Pro and Business subscriptions can claim API credits by linking an API organization. Those credits require
API credentials and have their own eligibility, expiry and limits; they do not increase signed-in Codex limits.
Source: [API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits).

For a new OpenAI API integration, the researched candidates are:

| Operation | Candidate | Constraint |
|---|---|---|
| Recorded speech to text | `gpt-transcribe` | Older Whisper and GPT-4o transcription models are deprecated, with shutdown February 26, 2027 |
| Spoken output | `gpt-realtime-2.1-mini` | Current TTS migration guidance requires a Realtime workflow; it cannot be substituted into `/v1/audio/speech` |
| Image generation/editing | `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | Flare for everyday generation; Sunburst for editing precision; separate from Codex's documented built-in model |
| Text embeddings | `text-embedding-3-small`, `text-embedding-3-large` | Text input; not a shared embedding space for arbitrary media |

Sources: [transcription](https://developers.openai.com/api/docs/guides/speech-to-text),
[speech output](https://developers.openai.com/api/docs/guides/text-to-speech),
[image API](https://developers.openai.com/api/docs/guides/image-generation),
[embeddings](https://developers.openai.com/api/docs/guides/embeddings).
These are dated candidates, not permanent defaults. Recheck availability and test the actual adapter before adopting one.

## Capability settings

| Owner-facing setting | Routing |
|---|---|
| Thinking | Existing Quick/Balanced/Deep selection |
| Understanding images | The reasoning model when capable; an explicitly configured fallback otherwise |
| Transcription | A speech-to-text provider and model, local or remote |
| Spoken replies | A speech output provider and model; the agent's voice belongs in its panel's About tab |
| Live conversation | A media session model that hands work to the agent |
| Image creation | A provider and model supporting generation and the required editing operations |
| Search | Optional embedding provider and model alongside keyword search |

Default to Automatic where a supported route exists. Provider and model details sit behind a disclosure; an
unconfigured capability says what is missing. Each capability may use a different provider and credential source:
subscription reasoning, API image creation and local transcription or embeddings can coexist.

The daemon's model inventory must distinguish:

- Supported operations and input/output modalities, including image editing and streaming where relevant.
- The adapter that implements each operation and the credentials it accepts.
- Catalog presence, configured credentials and observed request failures. None proves the others.
- Limits needed to prepare valid requests, such as media size, format and context limits.

A route resolves an operation to provider, model, adapter and credential reference. Credentials stay with the daemon.
The store holds the owner's settings and what each operation actually used. Agent definitions remain files; there
is no second copy of them in routing settings.

Routing is deterministic. Validate capabilities before sending bytes. A pinned agent model still governs its
reasoning; it does not implicitly select transcription or image generation. If that model cannot read an image,
use the configured image route or report the limitation. A derived description must retain its source and must
not be presented as if the reasoning model saw the original.

Resolve and record a route before an operation starts. Settings changes apply to subsequent operations, preserving
the existing rule that a reasoning run never mixes models. Automatic must not silently change the data recipient,
credential source or spending policy when an operation fails. Fallbacks are explicit owner choices.

## Media in one chat

Preserve original media as blobs. The store records their message or artifact references, formats, provenance and
relationships to transcripts, descriptions and generated versions. A caption or transcript supplements the original.
Preparing a smaller image or extracting video frames produces derived inputs with a link to their source.

Voice input is transcribed on the owner's side of the box boundary, then enters the existing chat as text with its
audio attached. Microphone capture and sending are visible and controllable. Text remains available for correction,
accessibility and clients without audio. A transcript from an uploaded recording or foreign speaker remains source
content; it does not gain the authority of the owner's instructions merely by becoming text.

Spoken replies render messages the agent sent through `message_user`. A live voice model may manage listening,
turn detection and interruption, but it cannot create a second task store or bypass tools, permissions and approvals.
Interrupting playback stops speech; stopping the run follows the existing Stop behavior. Reconnection must not
resubmit a spoken turn or replay a consequential action. Voice never approves an action on the floor.

Generated images and audio enter the same blob, attachment and artifact paths as other work products. Editing
references exact source blobs and creates a new version. The owner can inspect, download and reuse the result.
Speech playback has a text equivalent and no unsolicited autoplay outside the voice interaction the owner started.

Full multimodality also includes documents, recorded audio beyond speech, video and live camera/screen input.
Their routes must declare whether they understand native media or derived text, frames and timestamps. Attaching a
file does not establish model understanding. Native video and live perception need separate evidence before design
depends on them; video generation is another optional operation if later required.

## Retrieval

Retain keyword search and add embeddings as a derived index. Keep vectors tied to source identity, content hash,
model/version, dimensions and preprocessing. Changing any of those rebuilds the affected index; never compare vectors
from incompatible spaces. Deleting a source removes its derived representations from search.

Start with text embeddings over messages, accepted memory and media transcripts/descriptions. This supports finding
media through words, but does not provide visual or acoustic similarity search. Native media retrieval requires a
provider with the appropriate shared embedding space and a demonstrated improvement on representative queries.

## Trust and durability

Media providers are data recipients, just as reasoning providers are. Settings name who receives each kind of data;
introducing a new recipient must follow the existing permission rules. Credentials never reach the box. Documents,
images, recordings and tool-produced transcripts retain their origin and trust constraints through conversion.

Use pi-durable's existing task and effect mechanisms before adding orchestration. Store each operation's selected
route, immutable inputs, relevant options, provider request/job identifiers and outcome; store large bytes as blobs.
Do not store credentials or create a parallel media task database.

Durable submission alone cannot guarantee that an external provider charges or generates only once. Reuse provider
idempotency or resumable jobs when supported and proven. If a crash leaves completion unknown and the provider cannot
reconcile it, surface the existing retry-or-skip Wait instead of silently issuing another paid request. Once a result
is stored, recovery reuses its bytes. Live transports are disposable; accepted turns and completed work are durable.

## Delivery and evidence

Deliver in owner-reviewed, end-to-end slices:

1. Capability discovery and routing with the existing tiers and image input: settings show actual adapter support,
   missing configuration and explicit fallback behavior.
2. Recorded speech and spoken replies in the existing chat, including correction, cancellation and text fallback.
3. Image generation and editing through attachments and versioned artifacts.
4. Hybrid retrieval over text and media derivatives, with rebuild and deletion guarantees.
5. Live voice, followed by native audio/video and live perception as their provider and boundary spikes succeed.

Extend pi-ai first where its existing interfaces fit; its installed model types are chat, image and classifier, with
no audio or embedding operation types. Keep pi-ai, pi-durable, pi-env and chord pinned in lockstep. Prefer no new
dependency. UI work uses the repository's ai-elements and shadcn components and joins the specimen.

Before committing to adapters, spike subscription image/voice access, audio transports, provider idempotency and
cancellation. Record evidence rather than assuming product features are callable from banda. Tests use faux
providers and temp homes, without network or keys; provider probes are separate recorded manual runs.

Every durable flow adds its effect boundaries to `test/fault/`: generated thrown-fault scenarios and a SIGKILL sweep
at every boundary, checked by shared invariants. Cover routing changes, duplicate delivery, uncertain completion,
interruption, reconnect, deletion and index rebuilds. Trust and durability changes get adversarial review. Each slice
must also be used through the app against a throwaway daemon at desktop and phone width before owner review.

Open questions for those spikes: can subscription media features be exposed through a supported adapter; which
local providers meet latency and quality needs; how live-session credentials and traffic preserve the daemon/box
boundary; which native media operations improve on derived inputs; and what retention and budget controls the owner
needs for recordings and long media jobs. Implementation should resolve these one slice at a time.

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] A voice for spoken replies, picked in the agent's panel with a sample each (DESIGN.md "Open")
