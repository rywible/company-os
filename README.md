# Company OS

A private workspace for steering a software company through its Foreman. The first working loop is **direction → contextual recommendation → proposal → human acceptance → versioned understanding**.

## What works

- One inbox for conversations with Foreman, questions, blockers and document proposals. New message starts a thread; replies stay in that thread.
- Research, bug and feature work tracks, independently scheduled, bounded research tasks, and read-only Chrome UI inspection on the Sprite.
- Configurable independent PR reviews, commit-specific quorum, worker feedback, verified corrections and new review rounds.
- A subject library with collections, parent/related subjects, versioned sources, Markdown editing and reindexing on edits. Foreman can create Knowledge documents directly from conversations, including architecture diagrams in Mermaid, and maintains the library from new documents and findings; human-edited pages and proposed changes of direction go to the inbox for review. Changed, missing, or withdrawn sources mark dependent subjects as needing review, including indirect dependencies. Those subjects stay out of automatic briefings until reviewed; explicit attachments carry a warning. Maintenance receives affected subjects directly and can reaffirm, revise, or withdraw them. Optional review dates cover time-sensitive knowledge. External sources require an explicit withdrawal or scheduled review; arbitrary upstream website changes are not automatically detected.
- Automatic briefings ordered as constitution, relevant knowledge, conversation and assignment. Inbox replies show exact saved revisions and selection reasons under Context used; later turns refresh knowledge.
- Typed domain events, explicit workflow triggers and a transactional outbox with inspectable failures and retries.
- Private login, mobile UI, installable PWA, SQLite volume and Litestream backups to Tigris.

General engineering implementation, PR creation, merge and deployment executors are still outside the application. Linked PR review and bounded source corrections are implemented. Agent reviewers currently use the same model and GitHub account; their comments are not GitHub branch-protection approvals. Correction authority defaults off.

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

Every configured Sprite has the `company-os` label. Google connector access is scoped to company Sprites and `/v1beta/models` plus `/v1beta/models/*`; GitHub access is scoped to `/user` and `rywible/company-os`. Connector IDs are configuration, not provider API keys. Subscription limits still apply; expired authentication appears as a failed run with recovery instructions.

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

The baseline intentionally omits Firefox and WebKit for v1. GitHub credentials
remain in the scoped Fly connector rather than on the Sprite filesystem.
The current validated base is `company-os-studio-base-v1` at checkpoint `v2`;
its earlier `v1` checkpoint is superseded.

The provisioned fleet is `company-os-studio-01` through
`company-os-studio-10`. The active pool currently contains the three
authenticated OpenAI workers (`01`–`03`); the remaining Sprites are kept out of
routing until their future Anthropic or Meta credentials are configured.
Company OS leases one compatible worker for each invocation and allows up to
`WORKER_CONCURRENCY` durable deliveries to overlap. Each automation stores its
provider, model and reasoning effort; Foreman’s defaults are editable in
Settings. A run snapshots that selection when queued.

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
litestream restore -config /etc/litestream.yml -o /tmp/recovery-check.sqlite /data/company.sqlite
sqlite3 /tmp/recovery-check.sqlite 'SELECT count(*) FROM documents; SELECT count(*) FROM events;'
```

For recovery, stop the writer first and preserve any existing database plus WAL before replacing data. A new empty mounted volume will restore on startup. Don't run two writers against one backup prefix. Codex run output lives separately under `/home/sprite/company-os/v2-runs/<run-id>`; completed responses are reused on retry. If a Sprite dies with a `running` marker but no result, inspect its process/logs before removing that marker and retrying.

Work exposes workflow history, runs and delivery failures; all events and revisions remain in SQLite. Multi-user permissions, workspace configuration, pagination, schema migrations, and automated backup monitoring are future work.

## Mobile and installation

Navigation has four destinations: Inbox, Constitution, Knowledge and Automation. Constitution opens directly into company direction, with editing, revision history, and discussion. All other documents live in Knowledge, alongside a secondary Evidence view for original findings. Automation owns scheduling, research perspectives, feedback and background work; Settings separates workspace configuration from review policy. The document editor has Markdown formatting tools, keyboard shortcuts, native undo and a rendered preview including Mermaid diagrams, with consistent gutters and a fixed save footer. Knowledge uses general documents instead of a subject-type picker. Context settings contain only Inclusion and Status and sit above the title and writing area; the editor has a word count and persistent Save action. Saving refreshes retrieval automatically. The interface uses a monochrome palette, compact headings, plain labels, document rows, and a small stamped wordmark. It uses a dedicated bottom navigation on phones and tablets, email-style inbox threads, 44px controls, safe-area spacing, and keyboard-aware viewport sizing. On phones, document editing and context inspection open full-screen; diagrams scroll horizontally to preserve readable labels. The interface uses system fonts without external font requests.

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
