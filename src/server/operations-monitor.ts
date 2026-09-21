import type { SQLiteRepository } from "../adapters/sqlite";
import type { Integrations } from "./integrations";
import { verifyRecovery } from "./recovery";
export class OperationsMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private auth?: Promise<void>;
  private restore?: Promise<void>;
  private lastAuth = 0;
  private lastRestore = 0;
  private started = Date.now();
  constructor(private repo: SQLiteRepository, private integrations: Integrations, private databasePath?: string) {}
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 60000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  tick() {
    const now = Date.now(), checkedAt = new Date(now).toISOString();
    this.repo.recordCheck("replication-heartbeat", {status:"ok",checkedAt,detail:"Replication freshness marker"});
    if (!this.auth && now - this.lastAuth >= 5 * 60000) {
      this.lastAuth = now;
      this.auth = Promise.all([this.integrations.workerHealth(),this.integrations.repositoryHealth()]).then(([checks,repository]) => {
        this.repo.recordCheck("repository",repository);
        this.repo.store.db.query("DELETE FROM operational_checks WHERE name LIKE 'worker:%'").run();
        for (const {name,...check} of checks) this.repo.recordCheck(`worker:${name}`,check);
      }).catch(() => this.repo.recordCheck("worker:connection", {status:"error",checkedAt,detail:"Worker authentication checks could not finish."}))
        .finally(() => { this.auth = undefined; this.repo.recordAlerts(); });
    }
    if (this.databasePath && process.env.BUCKET_NAME && !this.restore && now - this.started >= 60000 && now - this.lastRestore >= 3600000) {
      this.lastRestore = now;
      this.restore = verifyRecovery(this.repo.store.db, this.databasePath).then(result => {
        this.repo.recordCheck("backup", result);
        if (result.status !== "ok") this.lastRestore = now - 55 * 60000;
      }).catch(() => this.repo.recordCheck("backup", {status:"error",checkedAt,detail:"The restore verification could not finish."}))
        .finally(() => { this.restore = undefined; this.repo.recordAlerts(); });
    }
    this.repo.recordAlerts(now);
  }
}
