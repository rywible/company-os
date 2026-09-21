import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vec from "sqlite-vec";

export type RecoveryResult = {
  status: "ok" | "error"; checkedAt: string; detail: string;
  documents?: number; revisions?: number; runs?: number; replicaAt?: string;
};
export async function verifyRecovery(live: Database, databasePath: string): Promise<RecoveryResult> {
  const checkedAt = new Date().toISOString();
  const temporary = await mkdtemp(join(tmpdir(), "company-os-restore-"));
  let restored: Database | undefined;
  try {
    // Restore into a unique scratch directory. Never replace or open the live
    // database as the restore destination; missing replicas must fail loudly.
    const child = Bun.spawn(["litestream", "restore", "-config", "/etc/litestream.yml", "-o", join(temporary, "restored.sqlite"), databasePath],
      { env: {...process.env, AWS_ENDPOINT_URL_S3: undefined}, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 120000);
    const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timeout));
    if (code !== 0) throw Error(`Backup restore failed: ${stderr.slice(-1000)}`);
    restored = new Database(join(temporary, "restored.sqlite"), {readonly:true});
    vec.load(restored);
    const integrity = restored.query("PRAGMA quick_check").all() as Record<string, unknown>[];
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok") throw Error("Restored database failed its integrity check.");
    const state = JSON.parse((restored.query("SELECT json FROM company_state WHERE id=1").get() as {json:string}).json);
    if (!Array.isArray(state.runs) || !Array.isArray(state.threads)) throw Error("Restored company state is invalid.");
    const migrated = restored.query("SELECT 1 FROM sqlite_master WHERE name='run_payloads'").get();
    if (migrated) for (const run of state.runs) {
      const row = restored.query("SELECT json FROM run_payloads WHERE id=?").get(run.id) as {json:string} | null;
      if (!row) throw Error(`Restored run is missing its saved payload: ${run.id}`);
      JSON.parse(row.json);
    }
    const documents = Number((restored.query("SELECT count(*) AS n FROM documents").get() as any).n);
    const revisions = Number((restored.query("SELECT count(*) AS n FROM revisions").get() as any).n);
    const hasChecks = restored.query("SELECT 1 FROM sqlite_master WHERE name='operational_checks'").get();
    const heartbeat = hasChecks ? restored.query("SELECT json FROM operational_checks WHERE name='replication-heartbeat'").get() as {json:string} | null : null;
    let replicaAt: string | undefined;
    if (heartbeat) {
      replicaAt = JSON.parse(heartbeat.json).checkedAt;
      if (!replicaAt || Date.now() - Date.parse(replicaAt) > 10 * 60000) throw Error("Backup restored, but replication is more than ten minutes behind.");
    } else {
      // Compatibility for the first restore drill, before heartbeats exist.
      const latest = live.query("SELECT id FROM domain_events ORDER BY sequence DESC LIMIT 1").get() as {id:string} | null;
      if (latest && !restored.query("SELECT 1 FROM domain_events WHERE id=?").get(latest.id)) throw Error("Backup restored, but it does not yet contain the latest company event.");
    }
    return {status:"ok", checkedAt, documents, revisions, runs:state.runs.length, replicaAt,
      detail:`Restored and checked ${documents} documents, ${revisions} revisions and ${state.runs.length} saved runs in an isolated database.`};
  } catch (error) {
    return {status:"error", checkedAt, detail:error instanceof Error ? error.message : "Backup restore failed."};
  } finally {
    restored?.close();
    await rm(temporary, {recursive:true, force:true});
  }
}
