import { initialDeliveryPolicy } from "../domain/delivery";
import {
  initialPlanning,
  planningAutomation,
  initialRoles,
  initialAvailability,
} from "../domain/planning";
import { taskForRun } from "../domain/automation";
import { automationPermissions } from "../domain/permissions";
import { importLibrary, libraryTask } from "../domain/library";
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
  constructor(
    public store: Store,
    now = new Date().toISOString(),
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS company_state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS domain_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,event_json TEXT NOT NULL,effect_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,error TEXT);
   CREATE INDEX IF NOT EXISTS delivery_ready ON deliveries(status,available_at);`);
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
    s.settings.delivery ??= initialDeliveryPolicy();
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
    this.store.db
      .query(
        "INSERT INTO company_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(JSON.stringify(state));
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
  events(entityId?: string) {
    const events = (
      this.store.db
        .query(
          "SELECT json FROM domain_events ORDER BY sequence DESC LIMIT 500",
        )
        .all() as { json: string }[]
    ).map((r) => JSON.parse(r.json) as DomainEvent);
    return entityId
      ? events.filter(
          (e) =>
            Object.values(e.payload).includes(entityId) ||
            e.correlationId === entityId,
        )
      : events;
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
    if (!current || !version || current.version === version) return current;
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
  search(query: string, vector?: number[], model?: string, limit = 6) {
    return this.store.search(query, vector, model, limit);
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
