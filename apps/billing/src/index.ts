// Server-side process only. Never bundled into the customer application.
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  BillingBridge,
  RemoteBillingProviders,
  billingConfigSchema,
} from "./bridge";
import { acquireWorkerLock } from "./lock";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server setting ${name}`);
  return value;
};
const directory = path.resolve(required("DEVICE_DECK_BILLING_HOME"));
const config = billingConfigSchema.parse(
  JSON.parse(await readFile(required("DEVICE_DECK_BILLING_CONFIG"), "utf8")),
);
const lemonToken = required("DEVICE_DECK_LEMON_TOKEN"),
  keygenToken = required("DEVICE_DECK_ISSUER_TOKEN"),
  secret = required("DEVICE_DECK_WEBHOOK_SECRET");
await mkdir(directory, { recursive: true, mode: 0o700 });
const releaseLock = acquireWorkerLock(directory);
const bridge = new BillingBridge(
  path.join(directory, "billing.sqlite"),
  config,
  secret,
  new RemoteBillingProviders(config, lemonToken, keygenToken),
);
let processing = false;
async function work(all = false) {
  if (processing) return;
  processing = true;
  try {
    await bridge.drain();
    if (all)
      for (const binding of config.bindings)
        await bridge.reconcile(binding.subscriptionId).catch(() => {});
  } finally {
    processing = false;
  }
}
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/lemon-squeezy") {
    res.writeHead(404).end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    bridge.accept(
      Buffer.concat(chunks),
      String(req.headers["x-signature"] || ""),
    );
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end('{"accepted":true}');
    void work();
  } catch {
    res.writeHead(400).end("Webhook rejected");
  }
});
server.listen(
  Number(process.env.DEVICE_DECK_BILLING_PORT || 8080),
  "127.0.0.1",
);
const retry = setInterval(() => void work(), 30000),
  hourly = setInterval(() => void work(true), 3600000);
void work(true);
console.log(
  `Device Deck billing worker started in ${config.testMode ? "test" : "live"} mode. Unmapped purchases await issuer registration.`,
);
async function close() {
  clearInterval(retry);
  clearInterval(hourly);
  server.close();
  while (processing) await new Promise((r) => setTimeout(r, 20));
  bridge.close();
  releaseLock();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
