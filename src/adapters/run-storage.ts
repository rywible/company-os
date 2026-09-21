import type { Database } from "bun:sqlite";
import type { CompanyState, Run } from "../domain/model";

const fields = ["context", "contextHistory", "result", "pendingOutput"] as const;
type Payload = Pick<Run, typeof fields[number]>;
// Payloads are loaded only when domain code asks for them. Metadata-only reads
// and saves never deserialize historical briefings or replacement-file results.
export class RunStorage {
  private loaded = new WeakMap<Run, { value?: Payload; original?: string }>();
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_payloads(id TEXT PRIMARY KEY, json TEXT NOT NULL);`);
    db.transaction(() => {
      if (db.query("SELECT 1 FROM schema_migrations WHERE version=1").get()) return;
      const row = db.query("SELECT json FROM company_state WHERE id=1").get() as {json:string} | null;
      if (row) {
        const state = JSON.parse(row.json) as CompanyState;
        const runs = state.runs.map(run => this.serialize(run));
        db.query("UPDATE company_state SET json=? WHERE id=1").run(JSON.stringify({...state, runs}));
      }
      db.query("INSERT INTO schema_migrations VALUES(1,?,?)").run("Separate saved run payloads from active state", new Date().toISOString());
    }).immediate();
  }
  attach(run: Run) {
    const record: {value?: Payload; original?: string} = {};
    const load = () => {
      if (!record.value) {
        const row = this.db.query("SELECT json FROM run_payloads WHERE id=?").get(run.id) as {json:string} | null;
        if (!row) throw Error(`Missing saved payload for run ${run.id}`);
        record.original = row.json;
        record.value = JSON.parse(row.json);
      }
      return record.value!;
    };
    this.loaded.set(run, record);
    for (const key of fields) Object.defineProperty(run, key, {
      enumerable: true, configurable: true,
      get: () => load()[key], set: value => { (load() as any)[key] = value; },
    });
  }
  serialize(run: Run) {
    const record = this.loaded.get(run);
    const metadata: any = {};
    for (const key of Object.keys(run)) if (!(fields as readonly string[]).includes(key)) metadata[key] = (run as any)[key];
    if (!record || record.value) {
      const payload = record?.value || Object.fromEntries(fields.map(key => [key, run[key]])) as Payload;
      const json = JSON.stringify(payload);
      if (json !== record?.original) this.db.query("INSERT INTO run_payloads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(run.id, json);
      // Do not update original here: an enclosing transaction can still roll back.
      metadata.hasContext = !!payload.context;
      metadata.contextSourceCount = payload.context?.documents.length || 0;
      metadata.resultSummary = payload.result ? { message: payload.result.message.slice(0, 4000), outcome: payload.result.outcome } : undefined;
    }
    return metadata;
  }
  summary(run: Run): Run {
    const metadata: any = {};
    for (const key of Object.keys(run)) if (!(fields as readonly string[]).includes(key)) metadata[key] = (run as any)[key];
    const summary = metadata.resultSummary;
    delete metadata.resultSummary;
    return { ...metadata, context: null, ...(summary ? {result: {...summary, changes: []}} : {}) };
  }
}
