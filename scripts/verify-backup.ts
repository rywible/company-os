import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { verifyRecovery } from "../src/server/recovery";
const store = new Store();
try {
  const repo = new SQLiteRepository(store);
  const result = await verifyRecovery(store.db, process.env.DATABASE_PATH || "./data/company.sqlite");
  repo.recordCheck("backup", result);
  repo.recordAlerts();
  console.log(JSON.stringify(result));
  if(result.status !== "ok") process.exitCode=1;
} finally { store.close(); }
