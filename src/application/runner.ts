import { Company, Deferred } from "./company";
// One executor per deployment. Deliveries are durable, serial and idempotent.
// Time is an input to the application; no agent is trusted to schedule itself.
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private polledAt = 0;
  constructor(
    private company: Company,
    private enabled: () => boolean,
  ) {}
  start() {
    this.company.repo.recover();
    this.timer = setInterval(
      () => void this.tick().catch((e) => console.error("Workflow runner:", e)),
      1500,
    );
    void this.tick().catch((e) => console.error("Workflow runner:", e));
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy || !this.enabled()) return;
    this.busy = true;
    try {
      if (Date.now() - this.polledAt > 60000) {
        this.polledAt = Date.now();
        await this.company.pollPullRequests();
      }
      this.company.heartbeat();
      const job = this.company.repo.claim();
      if (!job) return;
      try {
        await this.company.deliver(job);
        this.company.repo.acknowledge(job.id);
      } catch (e) {
        const error = e instanceof Error ? e.message : "Execution failed";
        const deferred = e instanceof Deferred;
        const retry =
          deferred || (job.effect.type !== "RunAgent" && job.attempts < 3);
        this.company.repo.reject(job.id, error, retry);
        if (!retry) {
          if (job.effect.type === "RunAgent")
            this.company.fail(job.effect.runId, error);
          else this.company.deliveryFailed(job, error);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
