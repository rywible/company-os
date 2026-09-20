import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as vec from "sqlite-vec";
import { legacyStarters } from "./legacy-starters";
import type {
  Document,
  Event,
  ForemanOutput,
  Message,
  Proposal,
  Run,
  SearchHit,
} from "../contracts";

if (process.platform === "darwin") {
  const library =
    process.env.SQLITE_LIBRARY ||
    [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    ].find(existsSync);
  if (library) Database.setCustomSQLite(library);
}
export const dimensions = 768;
export class Conflict extends Error {}
export class Store {
  db: Database;
  constructor(path = process.env.DATABASE_PATH || "./data/company.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
    );
    vec.load(this.db);
    this.db.exec(`
   CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,actor TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
   CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,level TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,source TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),version INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,actor TEXT NOT NULL,event_id INTEGER NOT NULL REFERENCES events(id),created_at TEXT NOT NULL,UNIQUE(document_id,version));
   CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,available_at INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
   CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,context TEXT NOT NULL DEFAULT '{}',result TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
   CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),title TEXT NOT NULL,kind TEXT NOT NULL,rationale TEXT NOT NULL,recommendation TEXT NOT NULL,document_id TEXT NOT NULL REFERENCES documents(id),content TEXT NOT NULL,evidence_refs TEXT NOT NULL,base_version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,resolved_at TEXT);
   CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),version INTEGER NOT NULL,model TEXT NOT NULL,text TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(embedding float[768]);
   CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(document_id UNINDEXED,title,content);
   CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY,response TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,available_at);
   CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id,version);
  `);
    const columns = this.db.query("PRAGMA table_info(documents)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "archived_at"))
      this.db.exec("ALTER TABLE documents ADD COLUMN archived_at TEXT");
    this.db.transaction(() => {
      for (const d of this.documents()) {
        if (
          d.source !== "bootstrap" ||
          d.version !== 1 ||
          !legacyStarters[d.id]
        )
          continue;
        const fingerprint = new Bun.CryptoHasher("sha256")
          .update(d.title + "\n" + d.content)
          .digest("hex");
        if (fingerprint !== legacyStarters[d.id]) continue;
        this.removeVectors(d.id);
        this.db.query("DELETE FROM document_fts WHERE document_id=?").run(d.id);
        this.db
          .query("UPDATE documents SET archived_at=? WHERE id=?")
          .run(new Date().toISOString(), d.id);
        this.db
          .query(
            "UPDATE jobs SET status='completed' WHERE entity_id=? AND status='queued'",
          )
          .run(d.id);
        this.event("STARTER_ARCHIVED", "system", d.id, {
          reason:
            "Untouched example content removed; revisions retained for history",
        });
      }
    })();
  }
  event(type: string, actor: string, entity: string, payload: unknown = {}) {
    return Number(
      this.db
        .query(
          "INSERT INTO events(type,actor,entity_id,payload) VALUES(?,?,?,?)",
        )
        .run(type, actor, entity, JSON.stringify(payload)).lastInsertRowid,
    );
  }
  enqueue(kind: string, entity: string, payload: unknown = {}) {
    this.db
      .query("INSERT INTO jobs(kind,entity_id,payload) VALUES(?,?,?)")
      .run(kind, entity, JSON.stringify(payload));
  }
  documents() {
    return this.db
      .query(
        `SELECT d.*, (SELECT MAX(version) FROM chunks c WHERE c.document_id=d.id) indexed_version FROM documents d WHERE archived_at IS NULL ORDER BY CASE level WHEN 'constitution' THEN 0 WHEN 'product' THEN 1 WHEN 'architecture' THEN 2 ELSE 3 END,title`,
      )
      .all() as Document[];
  }
  document(id: string) {
    return this.documents().find((d) => d.id === id);
  }
  saveDocument(
    input: {
      id?: string;
      title: string;
      level: string;
      content: string;
      expectedVersion?: number;
    },
    actor = "human",
    schedule = true,
  ) {
    return this.db.transaction(() => {
      const id = input.id || crypto.randomUUID(),
        existing = this.document(id);
      if (
        actor !== "human" &&
        actor !== "bootstrap" &&
        (existing?.level === "constitution" || input.level === "constitution")
      )
        throw new Conflict("Only Ryan can change the constitution.");
      if (existing && input.expectedVersion !== existing.version)
        throw new Conflict(
          "This document changed. Reload the latest version before saving.",
        );
      if (existing && existing.level !== input.level)
        throw new Conflict("Document level cannot be changed.");
      if (
        !existing &&
        input.level === "constitution" &&
        this.documents().some((d) => d.level === "constitution")
      )
        throw new Conflict("There is already a constitution.");
      const version = (existing?.version || 0) + 1,
        now = new Date().toISOString();
      this.db
        .query(
          "INSERT INTO documents(id,title,level,content,version,updated_at,source) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,version=excluded.version,updated_at=excluded.updated_at,source=excluded.source",
        )
        .run(id, input.title, input.level, input.content, version, now, actor);
      const event = this.event(
        existing ? "DOCUMENT_REVISED" : "DOCUMENT_CREATED",
        actor,
        id,
        { version, title: input.title, level: input.level },
      );
      this.db
        .query(
          "INSERT INTO revisions(document_id,version,title,content,actor,event_id,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, version, input.title, input.content, actor, event, now);
      this.db.query("DELETE FROM document_fts WHERE document_id=?").run(id);
      this.db
        .query(
          "INSERT INTO document_fts(document_id,title,content) VALUES(?,?,?)",
        )
        .run(id, input.title, input.content);
      this.removeVectors(id);
      if (schedule) this.enqueue("embed", id, { version });
      return this.document(id)!;
    })();
  }
  removeVectors(id: string) {
    const rows = this.db
      .query("SELECT id FROM chunks WHERE document_id=?")
      .all(id) as { id: number }[];
    for (const row of rows)
      this.db.query("DELETE FROM chunk_vectors WHERE rowid=?").run(row.id);
    this.db.query("DELETE FROM chunks WHERE document_id=?").run(id);
  }
  indexDocument(
    id: string,
    version: number,
    model: string,
    chunks: { text: string; vector: number[] }[],
  ) {
    return this.db.transaction(() => {
      if (this.document(id)?.version !== version) return false;
      this.removeVectors(id);
      for (const c of chunks) {
        if (
          c.vector.length !== dimensions ||
          c.vector.some((v) => !Number.isFinite(v))
        )
          throw new Error("Invalid embedding");
        const row = this.db
          .query(
            "INSERT INTO chunks(document_id,version,model,text) VALUES(?,?,?,?)",
          )
          .run(id, version, model, c.text);
        this.db
          .query("INSERT INTO chunk_vectors(rowid,embedding) VALUES(?,?)")
          .run(Number(row.lastInsertRowid), new Float32Array(c.vector));
      }
      this.event("UNDERSTANDING_INDEXED", "system", id, {
        version,
        chunks: chunks.length,
        model,
      });
      return true;
    })();
  }
  search(
    query: string,
    vector?: number[],
    model?: string,
    limit = 6,
  ): SearchHit[] {
    const terms = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20) || [];
    const fts = terms
      .map((t) => '"' + t.replaceAll('"', '""') + '"')
      .join(" OR ");
    const lexical = fts
      ? (this.db
          .query(
            "SELECT document_id FROM document_fts WHERE document_fts MATCH ? ORDER BY bm25(document_fts) LIMIT 15",
          )
          .all(fts) as { document_id: string }[])
      : [];
    const semantic = vector
      ? (this.db
          .query(
            `SELECT c.document_id,c.text,vec_distance_cosine(v.embedding,?) distance FROM chunk_vectors v JOIN chunks c ON c.id=v.rowid JOIN documents d ON d.id=c.document_id AND d.version=c.version WHERE c.model=? ORDER BY distance LIMIT 24`,
          )
          .all(new Float32Array(vector), model!) as {
          document_id: string;
          text: string;
          distance: number;
        }[])
      : [];
    const rank = new Map<
      string,
      { score: number; excerpt: string; match: string }
    >();
    lexical.forEach((r, i) =>
      rank.set(r.document_id, {
        score: 1 / (60 + i + 1),
        excerpt: "",
        match: "keyword",
      }),
    );
    const seen = new Set<string>();
    let index = 0;
    for (const r of semantic) {
      if (seen.has(r.document_id)) continue;
      seen.add(r.document_id);
      const prev = rank.get(r.document_id);
      rank.set(r.document_id, {
        score: (prev?.score || 0) + 1 / (60 + ++index),
        excerpt: r.text,
        match: prev ? "hybrid" : "semantic",
      });
    }
    return this.documents()
      .filter((d) => rank.has(d.id))
      .map((d) => ({
        ...d,
        ...rank.get(d.id)!,
        excerpt: rank.get(d.id)!.excerpt || d.content.slice(0, 450),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(60, limit));
  }
  direction(content: string, key: string) {
    return this.db.transaction(() => {
      const saved = this.db
        .query("SELECT response FROM idempotency WHERE key=?")
        .get(key) as { response: string } | null;
      if (saved) return JSON.parse(saved.response) as { runId: string };
      if (
        this.db
          .query("SELECT 1 FROM runs WHERE status IN ('queued','running')")
          .get()
      )
        throw new Conflict(
          "The Foreman is already considering your last direction.",
        );
      const run = crypto.randomUUID(),
        now = new Date().toISOString();
      this.db
        .query("INSERT INTO runs(id,status,created_at) VALUES(?,?,?)")
        .run(run, "queued", now);
      this.db
        .query("INSERT INTO messages VALUES(?,?,?,?,?)")
        .run(crypto.randomUUID(), "human", content, run, now);
      this.event("DIRECTION_RECEIVED", "human", run, { content });
      this.enqueue("foreman", run);
      const result = { runId: run };
      this.db
        .query("INSERT INTO idempotency VALUES(?,?)")
        .run(key, JSON.stringify(result));
      return result;
    })();
  }
  completeRun(
    id: string,
    output: ForemanOutput,
    context: {
      documents: Document[];
      evidenceRefs: string[];
      [key: string]: unknown;
    },
  ) {
    this.db.transaction(() => {
      const run = this.db
        .query("SELECT status FROM runs WHERE id=?")
        .get(id) as { status: string } | null;
      if (run?.status === "completed") return;
      const now = new Date().toISOString();
      for (const p of output.proposals) {
        const doc = context.documents.find((d) => d.id === p.documentId);
        if (!doc || doc.level === "constitution")
          throw new Error("Foreman proposed an unknown or protected document.");
        if (p.evidenceRefs.some((ref) => !context.evidenceRefs.includes(ref)))
          throw new Error("Foreman cited evidence outside its context.");
        const proposalId = crypto.randomUUID();
        this.db
          .query(
            "INSERT INTO proposals(id,run_id,title,kind,rationale,recommendation,document_id,content,evidence_refs,base_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            proposalId,
            id,
            p.title,
            p.kind,
            p.rationale,
            p.recommendation,
            p.documentId,
            p.content,
            JSON.stringify(p.evidenceRefs),
            doc.version,
            now,
          );
        this.event("PROPOSAL_CREATED", "foreman", proposalId, {
          runId: id,
          title: p.title,
          documentId: p.documentId,
        });
      }
      this.db
        .query("INSERT INTO messages VALUES(?,?,?,?,?)")
        .run(crypto.randomUUID(), "foreman", output.message, id, now);
      this.db
        .query(
          "UPDATE runs SET status='completed',result=?,finished_at=?,error=NULL WHERE id=?",
        )
        .run(JSON.stringify(output), now, id);
      this.event("FOREMAN_COMPLETED", "foreman", id, {
        proposals: output.proposals.length,
      });
    })();
  }
  resolveProposal(id: string, action: "accept" | "dismiss") {
    return this.db.transaction(() => {
      const p = this.db
        .query("SELECT * FROM proposals WHERE id=?")
        .get(id) as Proposal | null;
      if (!p) throw new Conflict("Proposal not found.");
      if (p.status !== "pending")
        throw new Conflict("This proposal has already been resolved.");
      if (action === "accept") {
        const d = this.document(p.document_id)!;
        this.saveDocument(
          {
            id: d.id,
            title: d.title,
            level: d.level,
            content: p.content,
            expectedVersion: p.base_version,
          },
          "accepted-proposal",
        );
      }
      this.db
        .query("UPDATE proposals SET status=?,resolved_at=? WHERE id=?")
        .run(
          action === "accept" ? "accepted" : "dismissed",
          new Date().toISOString(),
          id,
        );
      this.event(
        action === "accept" ? "PROPOSAL_ACCEPTED" : "PROPOSAL_DISMISSED",
        "human",
        id,
        { title: p.title, documentId: p.document_id },
      );
    })();
  }
  snapshot() {
    return {
      documents: this.documents(),
      events: this.db
        .query("SELECT * FROM events ORDER BY id DESC LIMIT 100")
        .all() as Event[],
      proposals: this.db
        .query("SELECT * FROM proposals ORDER BY created_at DESC")
        .all() as Proposal[],
      messages: this.db
        .query(
          "SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT 200) ORDER BY created_at",
        )
        .all() as Message[],
      runs: this.db
        .query("SELECT * FROM runs ORDER BY created_at DESC LIMIT 30")
        .all() as Run[],
      jobs: this.db
        .query("SELECT status,COUNT(*) count FROM jobs GROUP BY status")
        .all() as { status: string; count: number }[],
    };
  }
  close() {
    this.db.close();
  }
}
