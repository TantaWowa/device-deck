import path from "node:path";
import { recoverWorkerLock } from "../apps/billing/src/lock";
if (process.argv.length !== 3)
  throw new Error("Supply the billing worker's private data directory");
recoverWorkerLock(path.resolve(process.argv[2]));
console.log(
  "Removed a verified dead billing worker lock. The worker can now restart.",
);
