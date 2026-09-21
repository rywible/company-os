import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { initialState, type Run } from "../src/domain/model";
import { operatingSummary } from "../src/application/operations";
const stores: Store[] = [];
afterEach(() => {for (const store of stores.splice(0)) store.close();});
function fixture() { const store = new Store(":memory:"); stores.push(store); return {store,repo:new SQLiteRepository(store)}; }
const run = (id:string):Run => ({id,automatic:false,trigger:"message",status:"completed",createdAt:"2026-09-20T10:00:00Z",error:null,
 context:{query:"x".repeat(30000),assembledAt:"2026-09-20T10:00:00Z",documents:[],entries:[],evidenceRefs:[],messages:[],searchMode:"keyword",scope:"company",constitutionRef:null}});
test("versioned migration preserves historical payloads, lightweight saves, nested edits and rollback", () => {
 const {store,repo} = fixture(), state = repo.state();
 state.runs = Array.from({length:100},(_,i)=>run(String(i)));
 store.db.query("UPDATE company_state SET json=?").run(JSON.stringify(state));
 store.db.query("DELETE FROM schema_migrations WHERE version=1").run();
 const upgraded = new SQLiteRepository(store);
 const metadata = (store.db.query("SELECT json FROM company_state").get() as any).json;
 expect(metadata.length).toBeLessThan(50000);
 expect(metadata).not.toContain("xxxxxxxxxx");
 expect(upgraded.state().runs[0]!.context!.query.length).toBe(30000);
 const loaded = upgraded.state();
 loaded.runs[0]!.context!.query = "nested update";
 upgraded.save(loaded);
 expect(upgraded.state().runs[0]!.context!.query).toBe("nested update");
 expect(upgraded.state().runs[99]!.context!.query.length).toBe(30000);
 expect(() => upgraded.transaction(() => {loaded.runs[0]!.context!.query="rollback";upgraded.save(loaded);throw Error("rollback");})).toThrow();
 expect(upgraded.state().runs[0]!.context!.query).toBe("nested update");
 upgraded.save(loaded);
 expect(upgraded.state().runs[0]!.context!.query).toBe("rollback");
 expect(new SQLiteRepository(store).state().runs).toHaveLength(100);
 expect(store.db.query("SELECT * FROM schema_migrations").all()).toHaveLength(2);
});
test("workspace excludes archived contexts and run pages remain stable as new work arrives", () => {
 const {repo} = fixture(), state = repo.state();
 state.runs = Array.from({length:125},(_,i)=>run(String(i)));
 repo.save(state);
 const workspace = repo.workspace();
 expect(workspace.runs).toHaveLength(50);
 expect(JSON.stringify(workspace)).not.toContain("xxxxxxxxxx");
 expect(workspace.runs.every(r=>r.hasContext && r.context===null)).toBe(true);
 const first = repo.runPage();
 expect(first.runs[0]!.id).toBe("124");
 const newer=repo.state();newer.runs.push(run("125"));repo.save(newer);
 const second=repo.runPage(first.nextCursor!);
 const third=repo.runPage(second.nextCursor!);
 expect(new Set([...first.runs,...second.runs,...third.runs].map(r=>r.id)).size).toBe(125);
 expect(third.nextCursor).toBeNull();
});
test("operating checks surface stalled work, CI failures, allowances, and stale recovery", () => {
 const now=Date.parse("2026-09-20T11:00:00Z"), state=initialState(new Date(now).toISOString());
 state.runs=[{...run("waiting"),status:"queued"},{...run("slow"),status:"running"}];
 const summary=operatingSummary(state,[{id:"ci",status:"pending",at:"2026-09-20T10:00:00Z",error:"Waiting for repository CI",type:"RunAgent"}],{
  backup:{status:"ok",checkedAt:"2026-09-18T00:00:00Z",detail:"Previously restored"},
  "worker:one":{status:"error",checkedAt:new Date(now).toISOString(),detail:"Authentication expired"},
 },now);
 expect(summary.alerts.map(a=>a.id)).toEqual(["run:waiting","run:slow","delivery:ci","check:backup","check:worker:one"]);
 expect(summary.alerts.find(a=>a.id==="check:backup")!.message).toContain("overdue");
});
test("operating alerts are deduplicated and record their resolution", () => {
 const {repo,store}=fixture();repo.recordAlerts();repo.recordAlerts();
 expect(store.db.query("SELECT * FROM operational_alerts").all()).toHaveLength(2);
 const checkedAt=new Date().toISOString();
 repo.recordCheck("backup",{status:"ok",checkedAt,detail:"Restored"});
 repo.recordCheck("worker:one",{status:"ok",checkedAt,detail:"Authenticated"});
 repo.recordAlerts();
 expect(store.db.query("SELECT * FROM operational_alerts WHERE resolved_at IS NULL").all()).toHaveLength(0);
});
test("event pagination filters the entity before applying a page limit", () => {
 const {repo,store}=fixture();
 for(let i=0;i<600;i++)store.db.query("INSERT INTO domain_events(id,json) VALUES(?,?)").run(String(i),JSON.stringify({id:String(i),payload:{runId:i<3?"old":"other"},correlationId:"elsewhere"}));
 expect(repo.events("old")).toHaveLength(3);
 expect(repo.events("old",3).map(e=>e.id)).toEqual(["1","0"]);
});
