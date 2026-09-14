import path from "node:path";
import { recoverWorkerLock } from "./lock";
const directory = process.argv[2] || process.env.DEVICE_DECK_BILLING_HOME;
if (!directory) throw new Error("Pass the billing home directory");
recoverWorkerLock(path.resolve(directory));
console.log("Billing worker lock recovered.");
