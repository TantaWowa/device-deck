import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  BillingBridge,
  RemoteBillingProviders,
  desiredAccess,
  type BillingConfig,
  type Subscription,
} from "./bridge";
import { acquireWorkerLock, recoverWorkerLock } from "./lock";
const config: BillingConfig = {
  storeId: 1,
  productId: 2,
  variantId: 3,
  testMode: true,
  keygenAccountId: "account",
  keygenProductId: "product",
  keygenProPolicyId: "pro",
  keygenTrialPolicyId: "trial",
  bindings: [{ subscriptionId: "123", licenseId: "license" }],
};
const secret = "test-only-webhook-secret";
const now = Date.now();
function subscription(): Subscription {
  return {
    id: "123",
    type: "subscriptions",
    attributes: {
      store_id: 1,
      product_id: 2,
      variant_id: 3,
      test_mode: true,
      status: "active",
      updated_at: new Date(now - 1000).toISOString(),
      renews_at: new Date(now + 30 * 86400000).toISOString(),
      ends_at: null,
      trial_ends_at: null,
      pause: null,
    },
  };
}
const event = (s = subscription()) =>
  Buffer.from(
    JSON.stringify({ meta: { event_name: "subscription_updated" }, data: s }),
  );
const signature = (raw: Buffer) =>
  createHmac("sha256", secret).update(raw).digest("hex");
test("billing verifies raw HMAC and mode, persists retries/replay, and reads authoritative state before applying", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-billing-")),
    file = path.join(directory, "state.sqlite");
  let current = subscription(),
    unavailable = true,
    updates = 0,
    clock = now;
  const provider = {
    subscription: async () => current,
    updateLicense: async () => {
      updates++;
      if (unavailable) throw new Error("Network retry");
    },
  };
  let bridge = new BillingBridge(file, config, secret, provider, () => clock);
  try {
    const raw = event();
    assert.throws(() => bridge.accept(raw, "0".repeat(64)), /signature/);
    assert.throws(
      () =>
        bridge.accept(Buffer.concat([raw, Buffer.from(" ")]), signature(raw)),
      /signature/,
    );
    const mismatch = subscription();
    mismatch.attributes.test_mode = false;
    assert.throws(
      () => bridge.accept(event(mismatch), signature(event(mismatch))),
      /mode mismatch/,
    );
    bridge.accept(raw, signature(raw));
    await bridge.drain();
    assert.equal(bridge.pending()[0].state, "retry");
    bridge.close();
    bridge = new BillingBridge(file, config, secret, provider, () => clock);
    unavailable = false;
    clock += 60000;
    await bridge.drain();
    assert.equal(bridge.pending().length, 0);
    assert.equal(updates, 2);
    bridge.accept(raw, signature(raw));
    await bridge.drain();
    assert.equal(updates, 2);
    current = subscription();
    current.attributes.test_mode = false;
    await assert.rejects(bridge.reconcile("123"), /mode mismatch/);
    assert.equal(updates, 2);
    current = subscription();
    current.attributes.updated_at = new Date(now - 2000).toISOString();
    assert.equal(await bridge.reconcile("123"), "stale");
    assert.equal(updates, 2);
  } finally {
    bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("billing preserves paid-through cancellation, ignores dunning retry dates, and handles both pause policies", () => {
  const s = subscription(),
    active = desiredAccess(s, undefined, now);
  const paid = active.paidThrough;
  s.attributes.updated_at = new Date(now).toISOString();
  for (const status of ["past_due", "unpaid"] as const) {
    s.attributes.status = status;
    s.attributes.renews_at = new Date(paid + 86400000).toISOString();
    assert.equal(desiredAccess(s, active, now).appliedExpiry, paid);
    assert.equal(desiredAccess(s, undefined, now).appliedExpiry, now);
  }
  s.attributes.status = "cancelled";
  s.attributes.ends_at = new Date(paid).toISOString();
  assert.equal(desiredAccess(s, active, now).appliedExpiry, paid);
  s.attributes.status = "paused";
  s.attributes.pause = { mode: "void", resumes_at: null };
  assert.equal(desiredAccess(s, active, now).appliedExpiry, paid);
  s.attributes.pause.mode = "free";
  assert.equal(desiredAccess(s, undefined, now).appliedExpiry, now + 86400000);
  s.attributes.status = "expired";
  s.attributes.ends_at = new Date(now - 1000).toISOString();
  assert.ok(desiredAccess(s, active, now).appliedExpiry < now);
});
test("unmapped purchases remain durably queued for explicit issuer registration", async () => {
  const bridge = new BillingBridge(
    ":memory:",
    { ...config, bindings: [] },
    secret,
    {
      subscription: async () => subscription(),
      updateLicense: async () => {
        assert.fail("Unmapped purchase must not create access");
      },
    },
    () => now,
  );
  try {
    const raw = event();
    bridge.accept(raw, signature(raw));
    await bridge.drain();
    assert.equal(bridge.pending()[0].state, "awaiting-issuer");
  } finally {
    bridge.close();
  }
});
test("authenticated trial-to-Pro conversion uses only pinned policies and preserves expiry and operator suspension", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  let currentPolicy = "trial";
  const transport = async (url: any, init: any) => {
    const method = init.method || "GET",
      body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    if (String(url).endsWith("/policies/pro"))
      return Response.json({
        data: {
          id: "pro",
          type: "policies",
          attributes: { transferStrategy: "KEEP_EXPIRY" },
          relationships: { product: { data: { id: "product" } } },
        },
      });
    if (method === "PUT") currentPolicy = body.data.id;
    return Response.json({
      data: {
        id: "license",
        type: "licenses",
        attributes: {
          suspended: true,
          metadata: {
            lemonSubscriptionId: "123",
            lemonTestMode: true,
            deviceDeckMode: "test",
          },
        },
        relationships: {
          product: { data: { id: "product" } },
          policy: { data: { id: currentPolicy } },
        },
      },
    });
  };
  const provider = new RemoteBillingProviders(
    config,
    "test-lemon-token",
    "test-issuer-token",
    transport as typeof fetch,
  );
  await provider.updateLicense("license", "123", now + 86400000, false);
  assert.deepEqual(
    calls.filter((x) => x.method !== "GET").map((x) => x.method),
    ["PATCH", "PUT"],
  );
  assert.deepEqual(
    calls.find((x) => x.method === "PATCH")!.body.data.attributes,
    { expiry: new Date(now + 86400000).toISOString() },
  );
  await provider.updateLicense("license", "123", now + 86400000, false);
  assert.equal(calls.filter((x) => x.method === "PUT").length, 1);
  await assert.rejects(
    provider.updateLicense("license", "123", now + 10000, true),
    /not bound/,
  );
});
test("billing lock rejects live owner recovery and permits restart after a verified dead owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-worker-lock-"));
  try {
    const release = acquireWorkerLock(directory);
    assert.throws(() => acquireWorkerLock(directory), /lock exists/);
    assert.throws(() => recoverWorkerLock(directory), /alive/);
    release();
    const { stdout } = await promisify(execFile)(process.execPath, [
      "-e",
      "console.log(process.pid)",
    ]);
    await writeFile(
      path.join(directory, "worker.lock"),
      JSON.stringify({
        pid: Number(stdout.trim()),
        token: "45671ac0-cae3-4b0a-8c38-82fac7c94196",
        created: new Date().toISOString(),
      }),
    );
    recoverWorkerLock(directory);
    const restarted = acquireWorkerLock(directory);
    restarted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("cancelled trials retain the trial policy until an active paid subscription is observed", () => {
  const s = subscription();
  s.attributes.status = "on_trial";
  s.attributes.trial_ends_at = new Date(now + 86400000).toISOString();
  const trial = desiredAccess(s, undefined, now);
  assert.equal(trial.trial, true);
  s.attributes.status = "cancelled";
  s.attributes.ends_at = s.attributes.trial_ends_at;
  const cancelled = desiredAccess(s, trial, now);
  assert.equal(cancelled.trial, true);
  s.attributes.status = "active";
  assert.equal(desiredAccess(s, cancelled, now).trial, false);
});
