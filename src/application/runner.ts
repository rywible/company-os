import { Company, Deferred } from "./company";
// Deliveries are durable and idempotent. External work may overlap up to the
// configured pool capacity; repository transitions remain transactional.
// Time is an input to the application; no agent is trusted to schedule itself.
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = 0;
  private claiming = false;
  private polledAt = 0;
  constructor(
    private company: Company,
    private enabled: () => boolean,
    private concurrency = 1,
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
    if (this.claiming || !this.enabled()) return;
    this.claiming = true;
    const work: Promise<void>[] = [];
    try {
      if (Date.now() - this.polledAt > 60000) {
        this.polledAt = Date.now();
        await this.company.pollPullRequests();
      }
      this.company.heartbeat();
      while (this.inFlight < Math.max(1, this.concurrency)) {
        const job = this.company.repo.claim();
        if (!job) break;
        this.inFlight++;
        work.push(
          this.process(job).finally(() => {
            this.inFlight--;
          }),
        );
      }
    } finally {
      this.claiming = false;
    }
    await Promise.all(work);
  }
  private async process(job: NonNullable<ReturnType<Company["repo"]["claim"]>>) {
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
  }
}
