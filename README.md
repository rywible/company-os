# Company OS

A private workspace for steering a software company through its Foreman. The first working loop is **direction → contextual recommendation → proposal → human acceptance → versioned understanding**.

The proposed replacement is described in the [Company OS v2 design](docs/V2-DESIGN.md). The rest of this README describes the current application.

## What works

- One inbox for conversations with Foreman, questions, blockers and document proposals. New message starts a thread; replies stay in that thread.
- Research, bug and feature work tracks, independently scheduled, bounded research tasks, and read-only Chrome UI inspection on the Sprite.
- Configurable independent PR reviews, commit-specific quorum, worker feedback, verified corrections and new review rounds.
- A subject library with collections, parent/related subjects, versioned sources, Markdown editing and reindexing on edits. Foreman can create Knowledge documents directly from conversations, including architecture diagrams in Mermaid, and maintains the library from new documents and findings; human-edited pages and proposed changes of direction go to the inbox for review. Changed, missing, or withdrawn sources mark dependent subjects as needing review, including indirect dependencies. Those subjects stay out of automatic briefings until reviewed; explicit attachments carry a warning. Maintenance receives affected subjects directly and can reaffirm, revise, or withdraw them. Optional review dates cover time-sensitive knowledge. External sources require an explicit withdrawal or scheduled review; arbitrary upstream website changes are not automatically detected.
- Automatic briefings ordered as constitution, relevant knowledge, conversation and assignment. Inbox replies show exact saved revisions and selection reasons under Context used; later turns refresh knowledge.
- Typed domain events, explicit workflow triggers and a transactional outbox with inspectable failures and retries.
- Private login, mobile UI, installable PWA, SQLite volume and Litestream backups to Tigris.

Approved implementation and correction assignments run in real Git clones on leased Sprites. Workers can inspect and edit the full project, install dependencies, run checks, add assets, delete files and commit. The executor pushes the finished commit to the delegated branch. Independent reviewers and code acceptance testers receive pinned local checkouts and tools; their findings are posted to GitHub. Review comments are not GitHub branch-protection approvals. Code authority defaults off; deployment remains separate.

## Stack and architecture

TypeScript and Bun 1.4.2: native HTTP, SQLite, bundling, Markdown, test runner and WebView. React renders the UI; Mermaid renders diagrams; sqlite-vec supplies vectors. The Sprites SDK, Zod and Lucide remain. Bun has no replacement for those remaining capabilities. No Vite, Vitest or Playwright.

See [Architecture](docs/ARCHITECTURE.md) for the C4 diagram and hexagonal boundaries, and [Workflows](docs/WORKFLOWS.md) for event contracts, PR review/correction, heartbeats and understanding.

The production entry point is `src/server/index.ts`. Domain rules live in `src/domain`, use cases and ports in `src/application`, and integration implementations in `src/adapters`. The original SQLite document store is reused for migration and retrieval; the original worker is no longer wired into production.

Agents return structured results. They do not receive database access. Provider credentials stay in Sprite connectors; Codex authentication stays on each OpenAI worker. Compatible invocations can overlap across the pool. Reviews resume the original assignment with its saved result and feedback in a new invocation.

## Local development

Use Bun 1.4.2 (pinned in `.bun-version` and Docker). macOS also needs Homebrew SQLite for loadable extensions: `brew install sqlite`.

```sh
bun install --frozen-lockfile
cp .env.example .env # Only when .env does not already exist
bun run dev
```

Open `http://127.0.0.1:3000`. One Bun process serves both the interface and API. Development binds to loopback and bypasses login. To serve the built interface directly, run `bun run build` and open `http://127.0.0.1:3000` after starting `bun run start`.

Set `SPRITES_TOKEN`, `SPRITE_POOL`, `GEMINI_CONNECTOR_ID`, and
`GITHUB_CONNECTOR_ID` in `.env`. `SPRITE_POOL` is a comma-separated list of
`name=provider` workers; provider is `openai`, `anthropic`, or `meta`. The
legacy `SPRITE_NAME` remains a single-OpenAI-worker fallback. Without a Sprite
token, documents and keyword search work, but queued agent/indexing work waits
for configuration. Production also requires `ADMIN_PASSWORD`,
`SESSION_SECRET`, and `PUBLIC_ORIGIN`.

Authenticate Codex independently on each OpenAI worker:

```sh
sprite -s company-os-studio-01 exec -- codex login --device-auth
sprite -s company-os-studio-01 exec -- codex login status
```

Every configured Sprite has the `company-os` label. Google connector access is scoped to company Sprites and `/v1beta/models` plus `/v1beta/models/*`; GitHub access is scoped to `/user`, `wrela/wrela`, and historical `rywible/company-os` work. `GITHUB_REPOSITORY` selects the managed product repository. Connector IDs are configuration, not provider API keys. Subscription limits still apply; expired authentication appears as a failed run with recovery instructions.

Set `ANTHROPIC_CONNECTOR_ID` or `META_CONNECTOR_ID` to route those clients
through Fly’s credential-injecting gateway; the application supplies only a
non-secret placeholder credential required by the client. Without an Anthropic
connector, Claude uses its own per-worker subscription login. Meta workers are
expected to use the Meta connector so the API key never lands on their disks.

### Studio worker baseline

Game-studio Sprites use one credential-free, versioned baseline. It contains the
common development environment, Chrome-only browser tooling for v1, the
Rust/WebAssembly toolchain, and the Codex, Claude Code, and Muse Code clients.
Provider authentication is applied independently after a worker is created; do
not create a reusable checkpoint from an authenticated worker.

Provision and verify an Ubuntu Sprite with:

```sh
sprite file push -s <sprite> -p scripts/provision-sprite-v1.sh scripts/verify-sprite-v1.sh /home/sprite/bootstrap/
sprite -s <sprite> exec -- bash /home/sprite/bootstrap/provision-sprite-v1.sh
sprite -s <sprite> exec -- bash /home/sprite/bootstrap/verify-sprite-v1.sh
```

The baseline intentionally omits Firefox and WebKit for v1. Personal GitHub credentials remain in the scoped Fly connector. Checkout execution creates temporary repository deploy keys: read-only for the agent and write access only in the publication wrapper after the agent exits. Both are revoked on completion.
The current validated base is `company-os-studio-base-v1` at checkpoint `v2`;
its earlier `v1` checkpoint is superseded.

The provisioned fleet is `company-os-studio-01` through
`company-os-studio-10`. The active pool currently contains the three
authenticated OpenAI workers (`01`–`03`); the remaining Sprites are kept out of
routing until their future Anthropic or Meta credentials are configured.
Company OS leases one compatible worker for each invocation and allows up to
`WORKER_CONCURRENCY` durable deliveries to overlap. Each automation stores its
provider, model and reasoning effort; Foreman’s defaults are editable in
Settings. Model and reasoning selectors use exact harness model IDs and
model-specific effort support. Company OS refreshes the Codex catalog from an
authenticated worker and caches it for 15 minutes, with seeds for temporary
harness outages and future providers. Providers without an active worker are
disabled. A run snapshots that selection when queued.

```sh
bun run typecheck
bun test
bun run build
```

Backend tests cover transactional document acceptance, context isolation, embedding races, heartbeat limits, review quorums, commit invalidation, correction loops, authentication and read-only inspection sessions. Chrome tests exercise the UI against real application workflows with fake external ports.

## Deployment and recovery

Configured resources:

- App: `company-os-rywible`, region `ord`, one shared CPU / 512 MB.
- Persistent volume: `company_data`, 1 GB.
- Tigris bucket: `company-os-rywible-backups` (private).
- Worker Sprites: `company-os-studio-01` through `company-os-studio-10`.

The Fly app requires the credentials from `.env` as Fly secrets. `fly storage create` attaches the Tigris credentials and `BUCKET_NAME`. Neither `.env` nor local data is sent in Docker builds. Deploy with:

```sh
fly deploy --remote-only --ha=false
```

**Keep exactly one application Machine.** It is the sole SQLite writer and job owner. Litestream is asynchronous disaster recovery, not high availability or zero-loss replication. There is no automatic failover. The app stays running so durable jobs can advance. This provisions billable Fly/Sprite/Tigris resources; it does not use Cloud SQL.

Startup restores only when `/data/company.sqlite` is absent. Missing backups are allowed on first boot; other restore errors stop startup. The explicit Tigris endpoint is necessary for compatible request signing. Litestream 0.5.17 and its release checksum are pinned in the Dockerfile.

To verify a backup without touching the live database:

```sh
fly ssh console --app company-os-rywible
bun run verify:backup
```

For recovery, stop the writer first and preserve any existing database plus WAL before replacing data. A new empty mounted volume will restore on startup. Don't run two writers against one backup prefix. Codex run output lives separately under `/home/sprite/company-os/v2-runs/<run-id>`; completed responses are reused on retry. If a Sprite dies with a `running` marker but no result, inspect its process/logs before removing that marker and retrying.

Work → Operating status shows recent shipments, inbox decisions, blocked work, remaining milestone and daily automation allowances, worker authentication, and recovery checks. Waiting runs warn after five minutes, long-running jobs after 35 minutes, and pending deliveries/CI after 15 minutes. Alerts are deduplicated and retain resolution history. Worker authentication is checked every five minutes. An hourly isolated restore verifies SQLite integrity, documents, revisions, saved run payloads, and a replication heartbeat no more than ten minutes old. Failed restores retry after five minutes; a restore check older than two hours is overdue. `/healthz` remains a process/database liveness check; `/readyz` reports whether operational alerts exist without exposing private details.

Historical run contexts and results live in `run_payloads`, outside the active state JSON. The workspace returns recent run summaries and summaries for the selected conversation/assignment. Full contexts load on demand; run history and workflow events have cursor pagination. Numbered, transactional `schema_migrations` record storage upgrades, and a newer unknown schema blocks an older application from opening it. Migration and restore details are in [Operations](docs/operations.md). Multi-user permissions remain future work.

## Mobile and installation

Navigation has four destinations: Inbox, Constitution, Knowledge and Work. Constitution opens directly into company direction, with editing, revision history, and discussion. All other documents live in Knowledge, alongside a secondary Evidence view for original findings. Work has two tabs: Milestones and Automations, with a single Schedule work action above them. Foreman proposes milestones; people discuss and approve the outcomes in Inbox. The dependency graph and execution diagnostics are optional expansions rather than a separate Assignments tab. Milestone proposals carry outcomes, acceptance criteria, boundaries, a run allowance, and a dependency DAG. Approval starts ready assignments; independent review accepts their results before descendants start. Settings contains role-to-model routing and weekday triage availability alongside workspace and review policy. The document editor has Markdown formatting tools, keyboard shortcuts, native undo and a rendered preview including Mermaid diagrams, with consistent gutters and a fixed save footer. Knowledge uses general documents instead of a subject-type picker. Context settings contain only Inclusion and Status and sit above the title and writing area; the editor has a word count and persistent Save action. Saving refreshes retrieval automatically. The interface uses a monochrome palette, compact headings, plain labels, document rows, and a small stamped wordmark. It uses a dedicated bottom navigation on phones and tablets, email-style inbox threads, 44px controls, safe-area spacing, and keyboard-aware viewport sizing. On phones, document editing and context inspection open full-screen; diagrams scroll horizontally to preserve readable labels. The interface uses system fonts without external font requests.

Company OS is an installable PWA. Open **Settings** for installation:

- iPhone/iPad: open in Safari, then **Share → Add to Home Screen**.
- Android/desktop: use the **Install app** button when offered, or the browser's installation menu.

The service worker caches only public icons and an offline reconnect screen. API responses, company documents, conversations, and mutations are never cached by the service worker. Offline changes are not queued. Existing in-memory content is marked offline; saving and sending wait for a connection. Bump the `company-os-public-*` cache version in `public/sw.js` when changing offline assets. Updated workers take over after existing app windows close, avoiding a forced reload during an edit.

```sh
bun run test:ui
# Optional: add system WebKit coverage on macOS
UI_BACKENDS=webkit,chrome bun run test:ui
```

Browser tests use `bun test` with built-in `Bun.WebView` and a private fixture server; no Playwright or live company data is involved. `bun test` runs backend tests, while `bun run test:ui` builds the app and runs browser tests in Chrome by default, including PWA offline checks. Bun uses an installed Chrome/Chromium; set `BUN_CHROME_PATH` if necessary. On macOS, `UI_BACKENDS=webkit,chrome` runs both engines, and `UI_BACKENDS=webkit` selects system WebKit alone.

The suite covers 320–1440px viewports, Markdown formatting/undo/preview, document editing/reindexing, automation controls, Mermaid rendering, context preview, inbox proposals, navigation, draft preservation, review configuration and a complete PR review round. Chrome additionally checks PWA icons, cache privacy, offline fallback, and reconnect. Bun’s WebView API is experimental. These are viewport tests, not device emulation; keyboard checks simulate the visual viewport shrinking. Physical-device behavior and native installation prompts still need device testing. Failure screenshots are saved in `.artifacts/`.

Worker browser inspection and correction verification require Chrome on the Sprite. The versioned studio baseline includes Chrome. On a new Linux Sprite, install Chrome/Chromium and verify Bun.WebView startup before enabling browser work. Chrome runs with `--no-sandbox` inside the isolated Sprite; inspection sessions themselves remain read-only.

### Milestone planning and delegation

Foreman proposes substantial assignments by role, establishing interfaces before parallel vertical streams. The dependency graph and execution details are optional expansions within each milestone. Roles expose names and capability descriptions to Foreman; provider, model and reasoning settings stay in Settings and are snapshotted when a run is queued. The initial roles are Architect, Implementer, Reviewer, Adjudicator, Acceptance tester and Investigator.

Milestone planning is a regular automation, initially scheduled every four hours with at most four runs per UTC day and a target of two proposed, active or paused milestones. Its instruction, schedule, execution profile and permissions are edited alongside all other automations under Work → Automations. A full pipeline suppresses planning until capacity opens and its cadence is due. Proposals always need explicit human approval. Run allowances include workers, reviews and failed-run retries; assignment review stops after three unsuccessful worker attempts.

Triage defaults to Monday–Friday, 9am–5pm America/Denver, including daylight saving time. Availability is context for human decisions, not a worker schedule. Approved independent work continues outside those hours; a blocked assignment holds only its descendants. No unanswered proposal becomes approved automatically.

Implementation and correction use the autonomous checkout executor. Default execution time is 30 minutes per invocation (`ENGINEERING_TIMEOUT_MS`, capped at two hours). The Sprite is the isolation boundary; the agent has full development tools inside it. Checkouts, logs and completed receipts stay under `/home/sprite/company-os/engineering/<run-id>` for recovery. Workers are pinned before dispatch so a retry can recover the same completed result. The publisher verifies branch ancestry, clean committed state, current authority and the remote head; it never force-pushes. Independent review and acceptance use separate detached checkouts at the supplied SHA. Branch protections and CI remain enforced. See [Milestone delivery](docs/delivery-workflow.md).

### Automation permissions

Foreman is the shared persona across scheduled tasks. Settings → Foreman selects the model for Inbox conversations; each automation snapshots its own execution profile. Schedule work creates a daily task with evidence-only write access by default. Users can separately allow adding Evidence, maintaining Knowledge, or proposing milestones. Existing discovery automations also have bounded investigation permission. Clearing all permissions leaves a task with read-only results, available on its automation row.

The application validates results against both the queued permissions and the current permissions before applying any changes. Later grants do not expand an already queued run; revocations constrain in-flight results. Unauthorized mixed outputs roll back atomically. Automations cannot approve milestones, edit governing documents, dispatch arbitrary work, or publish source changes through these permissions. Knowledge writes retain the existing human-edit and direction-change approval requirements.

Existing milestone planning settings migrate once into a normal automation without losing milestones or run attribution. Deleting that automation removes its schedule; it is not recreated on restart. Pending executions of deleted automations are cancelled before agent dispatch.
