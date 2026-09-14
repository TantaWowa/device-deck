// Server-only: this process and its secrets never enter the customer application.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  BillingBridge,
  RemoteBillingProviders,
  billingConfigSchema,
} from "./bridge";
import { acquireWorkerLock } from "./lock";
import { billingServer } from "./http";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server setting ${name}`);
  return value;
};
const directory = path.resolve(required("DEVICE_DECK_BILLING_HOME"));
const config = billingConfigSchema.parse(
  JSON.parse(await readFile(required("DEVICE_DECK_BILLING_CONFIG"), "utf8")),
);
const providers = new RemoteBillingProviders(
  config,
  required("DEVICE_DECK_LEMON_TOKEN"),
  required("DEVICE_DECK_ISSUER_TOKEN"),
  fetch,
  required("DEVICE_DECK_ISSUANCE_SECRET"),
);
// Fail before opening the listener if credentials or pinned provider identities disagree.
await providers.preflight();
await mkdir(directory, { recursive: true, mode: 0o700 });
const releaseLock = acquireWorkerLock(directory);
let bridge: BillingBridge;
try {
  bridge = new BillingBridge(
    path.join(directory, "billing.sqlite"),
    config,
    required("DEVICE_DECK_WEBHOOK_SECRET"),
    providers,
  );
} catch (e) {
  releaseLock();
  throw e;
}
let processing = false,
  closing = false,
  lastWork = 0;
async function work(all = false) {
  if (processing || closing) return;
  processing = true;
  try {
    if (all)
      for (const subscription of bridge.subscriptions())
        bridge.enqueue(subscription);
    await bridge.drain();
    lastWork = Date.now();
  } catch {
    console.error(
      "Billing worker failed; inspect authenticated /admin/status and retry queue.",
    );
  } finally {
    processing = false;
  }
}
const server = billingServer({
  bridge,
  publicUrl: required("DEVICE_DECK_BILLING_PUBLIC_URL"),
  adminSecret: required("DEVICE_DECK_BILLING_ADMIN_SECRET"),
  wake: () => {
    void work();
  },
  ready: () => !closing && lastWork > Date.now() - 120000,
});
server.listen(
  Number(process.env.DEVICE_DECK_BILLING_PORT || 8080),
  process.env.DEVICE_DECK_BILLING_HOST || "127.0.0.1",
);
const retry = setInterval(() => {
    void work();
  }, 30000),
  hourly = setInterval(() => {
    void work(true);
  }, 3600000);
void work(true);
console.log(
  `Device Deck billing worker started in ${config.testMode ? "test" : "live"} mode.`,
);
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(retry);
  clearInterval(hourly);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  while (processing) await new Promise((resolve) => setTimeout(resolve, 20));
  bridge.close();
  releaseLock();
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
