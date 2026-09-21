import { operatingSummary, type OperationalCheck } from "../application/operations";
import { RunStorage } from "./run-storage";
import { migrateDeliveryPolicy } from "../domain/delivery";
import {
  initialPlanning,
  planningAutomation,
  initialRoles,
  initialAvailability,
} from "../domain/planning";
import { taskForRun } from "../domain/automation";
import { automationPermissions } from "../domain/permissions";
import { importLibrary, libraryTask, intakeReferences } from "../domain/library";
import type { Document } from "../contracts";
import { initialDiscovery } from "../domain/discovery";
import { Store } from "../server/store";
import { initialState, policySchema, type CompanyState } from "../domain/model";
import { defaultAgentConfiguration } from "../domain/agents";
import { cronFromHours } from "../domain/cron";
import {
  eventPayloads,
  type DomainEvent,
  type EventInput,
  type Delivery,
} from "../domain/events";
import { workflows } from "../domain/workflows";
import type { Repository } from "../application/ports";
export class SQLiteRepository implements Repository {
  private runStorage: RunStorage;
  constructor(
    public store: Store,
    now = new Date().toISOString(),
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS company_state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS domain_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,event_json TEXT NOT NULL,effect_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,error TEXT);
   CREATE INDEX IF NOT EXISTS delivery_ready ON deliveries(status,available_at);`);
    this.runStorage = new RunStorage(store.db);
    this.transaction(() => {
      const latest = store.db.query("SELECT max(version) AS version FROM schema_migrations").get() as {version:number};
      if (latest.version > 3) throw Error("Database schema is newer than this application. Restore the matching release.");
      if (!store.db.query("SELECT 1 FROM schema_migrations WHERE version=2").get()) {
        store.db.exec("CREATE TABLE IF NOT EXISTS operational_checks(name TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operational_alerts(id TEXT PRIMARY KEY,message TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,resolved_at TEXT);");
        store.db.query("INSERT INTO schema_migrations VALUES(2,?,?)").run("Operating checks and alert history", now);
      }
    });
    if (!store.db.query("SELECT 1 FROM company_state").get())
      this.transaction(() => {
        const state = initialState(now),
          legacy = store.snapshot();
        if (legacy.messages.length) {
          state.threads.push({
            id: "imported-conversation",
            kind: "conversation",
            subject: "Previous conversation",
            status: "open",
            unread: false,
            reason: "Imported from the original workspace",
            recommendation: "",
            evidence: [],
            messages: legacy.messages.map((m) => ({
              id: m.id,
              role: m.role === "human" ? "human" : "foreman",
              content: m.content,
              at: m.created_at,
            })),
            proposals: [],
            createdAt: now,
            updatedAt: now,
          });
        }
        for (const p of legacy.proposals)
          state.threads.push({
            id: "imported-" + p.id,
            kind: "inbox",
            subject: p.title,
            status: p.status === "pending" ? "open" : "resolved",
            unread: p.status === "pending",
            reason: p.rationale,
            recommendation: p.recommendation,
            evidence: JSON.parse(p.evidence_refs),
            messages: [],
            proposals: [
              {
                id: p.id,
                documentId: p.document_id,
                version: p.base_version,
                content: p.content,
                reason: p.rationale,
                evidence: JSON.parse(p.evidence_refs),
                status: p.status as "pending" | "accepted" | "dismissed",
              },
            ],
            createdAt: p.created_at,
            updatedAt: p.resolved_at || p.created_at,
          });
        state.library = importLibrary(this.documents());
        this.save(state);
        for (const d of this.documents())
          if (d.indexed_version !== d.version)
            this.publish(
              {
                type: "KnowledgeChanged",
                payload: { documentId: d.id, version: d.version },
              },
              {
                actor: "system",
                correlationId: d.id,
                causationId: null,
                at: now,
              },
            );
      });
  }
  transaction<T>(fn: () => T): T {
    // These transactions all mutate state. Reserve the write lock before the
    // first read so a Litestream checkpoint cannot make SQLite fail while a
    // deferred transaction is being upgraded from reader to writer.
    return this.store.db.transaction(fn).immediate();
  }
  state(): CompanyState {
    const s = JSON.parse(
      (
        this.store.db
          .query("SELECT json FROM company_state WHERE id=1")
          .get() as { json: string }
      ).json,
    );
    for (const run of s.runs) this.runStorage.attach(run);
    // Ignore removed policy metadata in existing workspaces; historical run snapshots remain intact.
    s.policies = Object.fromEntries(
      Object.entries(s.policies || {}).map(([id, policy]) => [
        id,
        policySchema.parse(policy),
      ]),
    );
    delete s.settings.scope;
    s.planning ||= initialPlanning();
    s.settings.roles ||= initialRoles();
    s.settings.availability ||= initialAvailability();
    s.discovery ||= initialDiscovery();
    if (!s.library) {
      s.library = importLibrary(this.documents());
      const task = libraryTask();
      task.enabled = s.settings.enabled !== false;
      s.discovery ||= initialDiscovery();
      if (!s.discovery.lenses.some((l: any) => l.id === task.id))
        s.discovery.lenses.push(task);
      this.save(s);
    }
    if (!s.discovery.lenses.some((l: any) => l.id === "knowledge-library")) {
      s.discovery.lenses.push(libraryTask());
      this.save(s);
    }
    if (!s.library.intakeVersion) {
      this.transaction(() => {
        s.library.intake ||= {};
        s.library.batches ||= {};
        s.library.receipts ||= [];
        for (const d of this.documents()) {
          if (d.level !== "intake" && (d.level !== "knowledge" || s.library.pages[d.id])) continue;
          const runId = d.content.match(/\nRun: ([^\s]+)\s*$/)?.[1];
          const run = s.runs.find((r: any) => r.id === runId);
          const work = s.work.find((w: any) => w.id === run?.workId);
          const sources = d.content.match(/\nSources: ([^\n]*)/)?.[1]?.split(", ").filter(Boolean) || [];
          this.store.db.query("UPDATE documents SET level='intake' WHERE id=?").run(d.id);
          s.library.intake[d.id] = {
            status: work && work.status !== "done" ? "collecting" : "ready",
            sources: [...new Set([...sources, ...intakeReferences(d.content)])], ...(runId ? { runId } : {}), ...(work ? { workId: work.id } : {}),
          };
          if (work) work.intakeIds = [...new Set([...(work.intakeIds || []), d.id])];
          if (s.library.intake[d.id].status === "ready") s.library.pending[d.id] = d.version;
          else delete s.library.pending[d.id];
          delete s.library.processed[d.id];
        }
        for (const id of Object.keys(s.library.pending))
          if (!s.library.intake[id]) delete s.library.pending[id];
        s.library.intakeVersion = 1;
        this.store.db.query("INSERT OR IGNORE INTO schema_migrations VALUES(3,?,?)").run("Separate disposable Intake from maintained Knowledge", new Date().toISOString());
        this.save(s);
      });
    }
    s.reviewRounds ||= [];
    s.discovery ||= initialDiscovery();
    if (s.discovery.taskSettingsVersion !== 1) {
      for (const lens of s.discovery.lenses) {
        lens.enabled =
          lens.enabled &&
          s.settings.enabled !== false &&
          s.discovery.enabled !== false;
        lens.dailyRunLimit ??= s.settings.dailyBudget || 6;
        lens.maxActiveIdeas ??= s.discovery.maxActiveIdeas || 6;
        lens.maxInvestigations ??= s.discovery.maxInvestigations || 2;
        lens.maxOpenWork ??= s.settings.maxOpenWork || 4;
        delete lens.exploratory;
      }
      s.discovery.taskSettingsVersion = 1;
      for (const key of [
        "enabled",
        "explorationEvery",
        "maxActiveIdeas",
        "maxInvestigations",
        "scoutsSinceExploration",
      ])
        delete s.discovery[key];
      this.save(s);
    }
    for (const lens of s.discovery.lenses) {
      lens.schedule ??= cronFromHours(lens.intervalHours || 24);
      lens.inspectUI ??= lens.id === "users";
      lens.sources ??= [];
      lens.agent ??= defaultAgentConfiguration();
    }
    if (!s.planning.automationVersion) {
      const task = planningAutomation(s.planning);
      task.agent = structuredClone(
        s.settings.foremanAgent || defaultAgentConfiguration(),
      );
      if (!s.discovery.lenses.some((l: any) => l.id === task.id))
        s.discovery.lenses.push(task);
      // Preserve attribution of historical planning runs and their model snapshots.
      for (const run of s.runs)
        if (run.trigger === "planning" && !run.discoveryLensId)
          run.discoveryLensId = task.id;
      s.planning.automationVersion = 1;
      this.save(s);
    }
    let assignedAuthority = false;
    for (const run of s.runs)
      if (
        !run.automationPermissions &&
        ["queued", "running"].includes(run.status)
      ) {
        const task = taskForRun(s, run);
        if (task) {
          run.discoveryLensId = task.id;
          run.automationPermissions = automationPermissions(task);
          assignedAuthority = true;
        }
      }
    if (assignedAuthority) this.save(s);
    delete s.settings.objective;
    s.settings.delivery = migrateDeliveryPolicy(s.settings.delivery);
    for (const milestone of s.planning.milestones)
      if (milestone.delivery)
        milestone.delivery.policy = migrateDeliveryPolicy(
          milestone.delivery.policy,
        );
    for (const run of s.runs)
      if (run.status !== "completed" && run.context?.acceptance?.policy)
        delete run.context.acceptance;

    for (const work of s.work.filter(
      (w: any) => w.pullRequest && !w.reviewProgress,
    )) {
      const rounds = s.reviewRounds.filter((r: any) => r.workId === work.id);
      const corrections = s.runs.filter(
        (r: any) =>
          r.workId === work.id &&
          r.trigger === "revision" &&
          rounds.some(
            (round: any) =>
              round.id === r.reviewRoundId &&
              round.reviews.some((v: any) => v.verdict === "changes_requested"),
          ),
      ).length;
      const latest = rounds.at(-1);
      work.reviewProgress = {
        policy: {
          correctionRounds:
            s.planning.milestones.find((m: any) => m.id === work.milestoneId)
              ?.delivery?.policy.correctionRounds ??
            s.settings.delivery.correctionRounds,
        },
        corrections,
        findings:
          latest?.reviews.flatMap((review: any) =>
            (
              review.issues ||
              review.findings.map((problem: string, i: number) => ({
                id: `legacy-${review.id}-${i}`,
                severity: "blocker",
                category: "correctness",
                problem,
                evidence:
                  "Imported review finding; separate supporting evidence was not recorded.",
                verification:
                  "Re-evaluate this historical finding against the current source and acceptance criteria.",
                status:
                  review.verdict === "changes_requested" ? "open" : "resolved",
              }))
            ).map((f: any) => ({
              ...f,
              head: latest.pullRequest.head,
              reviewerId: review.id,
            })),
          ) || [],
      };
    }
    for (const role of initialRoles().filter((r) =>
      ["adjudicator", "acceptance"].includes(r.id),
    ))
      if (!s.settings.roles.some((r: any) => r.id === role.id))
        s.settings.roles.push(role);
    s.settings.requiredReviews ??= 2;
    s.settings.allowCodeChanges ??= false;
    s.settings.foremanAgent ??= defaultAgentConfiguration();
    return s;
  }
  save(state: CompanyState) {
    this.transaction(() => {
      const runs = state.runs.map(run => this.runStorage.serialize(run));
      this.store.db.query("INSERT INTO company_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
        .run(JSON.stringify({...state, runs}));
    });
  }
  workspace(threadId?: string, workId?: string) {
    const state = this.state();
    const recent = new Set(state.runs.slice(-50).map(run => run.id));
    return {...state, runs: state.runs.filter(run => recent.has(run.id) || ["running","queued"].includes(run.status) ||
      (threadId && run.threadId === threadId) || (workId && run.workId === workId)).map(run => this.runStorage.summary(run))};
  }
  recordCheck(name: string, check: OperationalCheck) {
    this.store.db.query("INSERT INTO operational_checks VALUES(?,?) ON CONFLICT(name) DO UPDATE SET json=excluded.json").run(name, JSON.stringify(check));
  }
  operations(now = Date.now()) {
    const checks = Object.fromEntries((this.store.db.query("SELECT name,json FROM operational_checks WHERE name!='replication-heartbeat'").all() as {name:string;json:string}[]).map(row => [row.name, JSON.parse(row.json)]));
    const unresolved = new Set(this.deliveryErrors().map(error => error.id));
    const deliveries = (this.store.db.query("SELECT id,status,error,json_extract(event_json,'$.at') AS at,json_extract(effect_json,'$.type') AS type FROM deliveries WHERE status IN ('pending','running','failed')").all() as any[]).filter(job => job.status !== "failed" || unresolved.has(job.id));
    return operatingSummary(this.state(), deliveries, checks, now);
  }
  recordAlerts(now = Date.now()) {
    const summary = this.operations(now), at = new Date(now).toISOString();
    this.transaction(() => {
      const current = new Set(summary.alerts.map(alert => alert.id));
      const previous = this.store.db.query("SELECT id FROM operational_alerts WHERE resolved_at IS NULL").all() as {id:string}[];
      for (const alert of summary.alerts) this.store.db.query(`INSERT INTO operational_alerts VALUES(?,?,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET message=excluded.message,last_seen=excluded.last_seen,resolved_at=NULL`).run(alert.id,alert.message,at,at);
      for (const alert of previous) if (!current.has(alert.id)) this.store.db.query("UPDATE operational_alerts SET resolved_at=? WHERE id=?").run(at,alert.id);
    });
    return summary;
  }
  runPage(before?: string, limit = 50, workId?: string) {
    const runs = this.state().runs.filter(run => !workId || run.workId === workId);
    const end = before ? runs.findIndex(run => run.id === before) : runs.length;
    if (end < 0) throw Error("Unknown run history cursor.");
    const start = Math.max(0, end - limit);
    return {runs: runs.slice(start, end).reverse().map(run => this.runStorage.summary(run)),
      nextCursor: start > 0 ? runs[start]!.id : null};
  }
  publish(
    input: EventInput,
    meta: {
      actor: DomainEvent["actor"];
      correlationId: string;
      causationId: string | null;
      at: string;
    },
  ) {
    eventPayloads[input.type].parse(input.payload);
    const event = {
      ...input,
      ...meta,
      id: crypto.randomUUID(),
      schemaVersion: 1,
      sequence: 0,
    } as DomainEvent;
    const result = this.store.db
      .query("INSERT INTO domain_events(id,json) VALUES(?,?)")
      .run(event.id, JSON.stringify(event));
    event.sequence = Number(result.lastInsertRowid);
    this.store.db
      .query("UPDATE domain_events SET json=? WHERE id=?")
      .run(JSON.stringify(event), event.id);
    workflows(event).forEach((effect, i) =>
      this.store.db
        .query(
          "INSERT INTO deliveries(id,event_json,effect_json) VALUES(?,?,?)",
        )
        .run(`${event.id}:${i}`, JSON.stringify(event), JSON.stringify(effect)),
    );
  }
  events(entityId?: string, before = Number.MAX_SAFE_INTEGER) {
    return (this.store.db.query(`SELECT json,sequence FROM domain_events
      WHERE sequence < ? AND (? IS NULL OR json_extract(json,'$.correlationId')=? OR
        EXISTS (SELECT 1 FROM json_each(domain_events.json,'$.payload') WHERE value=?))
      ORDER BY sequence DESC LIMIT 100`).all(before, entityId || null, entityId || null, entityId || null) as {json:string;sequence:number}[])
      .map(row => ({...JSON.parse(row.json), sequence:row.sequence}) as DomainEvent);
  }
  claim(): Delivery | null {
    return this.transaction(() => {
      const row = this.store.db
        .query(
          "SELECT * FROM deliveries WHERE status='pending' AND available_at<=? ORDER BY CASE WHEN json_extract(effect_json,'$.type') IN ('IndexKnowledge','QueueLibrarySource') THEN 1 ELSE 0 END,rowid LIMIT 1",
        )
        .get(Date.now()) as any;
      if (!row) return null;
      this.store.db
        .query(
          "UPDATE deliveries SET status='running',attempts=attempts+1 WHERE id=?",
        )
        .run(row.id);
      return {
        id: row.id,
        event: JSON.parse(row.event_json),
        effect: JSON.parse(row.effect_json),
        attempts: row.attempts + 1,
      };
    });
  }
  acknowledge(id: string) {
    this.store.db
      .query("UPDATE deliveries SET status='completed',error=NULL WHERE id=?")
      .run(id);
  }
  reject(id: string, error: string, retry: boolean) {
    this.store.db
      .query("UPDATE deliveries SET status=?,error=?,available_at=? WHERE id=?")
      .run(retry ? "pending" : "failed", error, Date.now() + 30000, id);
  }
  retryDelivery(id: string) {
    const row = this.store.db
      .query(
        "SELECT effect_json FROM deliveries WHERE id=? AND status='failed'",
      )
      .get(id) as { effect_json: string } | null;
    if (!row) throw new Error("Failed delivery not found.");
    if (JSON.parse(row.effect_json).type === "RunAgent")
      throw new Error("Use Retry on the failed run.");
    this.store.db
      .query(
        "UPDATE deliveries SET status='pending',available_at=0,error=NULL,attempts=0 WHERE id=?",
      )
      .run(id);
  }
  recover() {
    this.store.db
      .query("UPDATE deliveries SET status='pending' WHERE status='running'")
      .run();
  }
  documents() {
    return this.store.documents();
  }
  document(id: string, version?: number) {
    const current =
      this.store.document(id) ||
      (version
        ? (this.store.db
            .query(
              "SELECT d.*, NULL indexed_version FROM documents d WHERE id=?",
            )
            .get(id) as Document | undefined)
        : undefined);
    if (!current || !version || current.version === version) return current || undefined;
    const r = this.store.db
      .query("SELECT * FROM revisions WHERE document_id=? AND version=?")
      .get(id, version) as any;
    return r
      ? {
          ...current,
          title: r.title,
          content: r.content,
          version: r.version,
          updated_at: r.created_at,
          indexed_version: null,
        }
      : undefined;
  }
  saveDocument(input: Parameters<Store["saveDocument"]>[0], actor = "human") {
    return this.store.saveDocument(input, actor, false);
  }
  archiveDocument(id: string, expectedVersion: number) {
    this.store.archiveDocument(id, expectedVersion);
  }
  deleteIntake(id: string, expectedVersion: number) {
    this.transaction(() => {
      const d = this.document(id);
      if (!d || d.level !== "intake" || d.version !== expectedVersion)
        throw Error("Intake changed or is no longer available. Reload before deleting.");
      this.store.removeVectors(id);
      this.store.db.query("DELETE FROM document_fts WHERE document_id=?").run(id);
      this.store.db.query("DELETE FROM revisions WHERE document_id=?").run(id);
      this.store.db.query("DELETE FROM proposals WHERE document_id=?").run(id);
      this.store.db.query("DELETE FROM jobs WHERE entity_id=?").run(id);
      this.store.db.query("DELETE FROM documents WHERE id=?").run(id);
    });
  }
  search(query: string, vector?: number[], model?: string, limit = 6, view: "all" | "library" | "intake" = "all") {
    return this.store.search(query, vector, model, limit, view);
  }
  index(...args: Parameters<Store["indexDocument"]>) {
    return this.store.indexDocument(...args);
  }
  chunks(id: string) {
    return this.store.db
      .query(
        "SELECT id,version,model,text FROM chunks WHERE document_id=? ORDER BY id",
      )
      .all(id) as {
      id: number;
      version: number;
      model: string;
      text: string;
    }[];
  }
  history(id: string) {
    return this.store.db
      .query(
        "SELECT * FROM revisions WHERE document_id=? ORDER BY version DESC",
      )
      .all(id);
  }
  deliveryErrors() {
    const state = this.state(),
      runs = state.runs;
    return (
      this.store.db
        .query(
          "SELECT id,error,attempts,effect_json FROM deliveries WHERE status='failed' ORDER BY rowid DESC",
        )
        .all() as {
        id: string;
        error: string;
        attempts: number;
        effect_json: string;
      }[]
    )
      .filter((row) => {
        const effect = JSON.parse(row.effect_json);
        return (
          effect.type !== "RunAgent" ||
          runs.some(
            (r) =>
              r.id === effect.runId &&
              r.status === "failed" &&
              (!r.reviewRoundId ||
                state.reviewRounds.find((round) => round.id === r.reviewRoundId)
                  ?.status !== "superseded"),
          )
        );
      })
      .slice(0, 20)
      .map(({ effect_json, ...row }) => row);
  }
}
