import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  BillingBridge,
  RemoteBillingProviders,
  type BillingConfig,
  type Subscription,
} from "./bridge";
import { billingServer } from "./http";
const config: BillingConfig = {
  storeId: 1,
  productId: 2,
  variantId: 3,
  testMode: true,
  keygenAccountId: "account",
  keygenProductId: "product",
  keygenProPolicyId: "pro",
  keygenTrialPolicyId: "trial",
  bindings: [],
};
const secret = "webhook-secret-for-tests-only",
  now = Date.parse("2026-09-13T12:00:00Z");
const sub = (): Subscription => ({
  id: "123",
  type: "subscriptions",
  attributes: {
    store_id: 1,
    product_id: 2,
    variant_id: 3,
    test_mode: true,
    customer_id: 99,
    user_email: "person@example.com",
    user_name: "A Person",
    order_id: 9,
    updated_at: new Date(now).toISOString(),
    status: "active",
    renews_at: new Date(now + 86400000).toISOString(),
    ends_at: null,
    trial_ends_at: null,
    pause: null,
  },
});
function accept(
  bridge: BillingBridge,
  eventName: string,
  data: any,
  custom?: any,
) {
  const raw = Buffer.from(
    JSON.stringify({
      meta: { event_name: eventName, custom_data: custom },
      data,
    }),
  );
  return bridge.accept(
    raw,
    createHmac("sha256", secret).update(raw).digest("hex"),
  );
}
function providers() {
  let ensures = 0,
    updates = 0;
  return {
    subscription: async () => sub(),
    ensureLicense: async () => {
      ensures++;
      return "license";
    },
    updateLicense: async () => {
      updates++;
    },
    licenseKey: async () => "PRIVATE-KEY",
    counts: () => ({ ensures, updates }),
  };
}
test("new paid subscriptions issue automatically, replay once, and retain bindings and retrieval across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-onboarding-"));
  const file = path.join(directory, "billing.sqlite"),
    p = providers();
  let bridge = new BillingBridge(file, config, secret, p, () => now);
  try {
    accept(bridge, "subscription_created", sub());
    await bridge.drain();
    assert.deepEqual(p.counts(), { ensures: 1, updates: 1 });
    const grant = bridge.retrievalGrant("123");
    assert.equal(
      bridge.db.prepare("SELECT digest FROM claims").get()?.digest ===
        grant.token,
      false,
    );
    bridge.close();
    bridge = new BillingBridge(file, config, secret, p, () => now);
    accept(bridge, "subscription_created", sub());
    await bridge.drain();
    assert.deepEqual(p.counts(), { ensures: 1, updates: 1 });
    assert.deepEqual(await bridge.retrieve(grant.token), {
      state: "ready",
      key: "PRIVATE-KEY",
    });
    assert.throws(
      () => new BillingBridge(file, { ...config, testMode: false }, secret, p),
      /database identity/,
    );
  } finally {
    bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("checkout credentials require the signed purchase binding, resist cross-subscription rebinding and expire", async () => {
  let clock = now,
    claim = "";
  const p = {
    ...providers(),
    createCheckout: async (id: string) => {
      claim = id;
      return "https://store.lemonsqueezy.com/checkout/test";
    },
  };
  const bridge = new BillingBridge(":memory:", config, secret, p, () => clock);
  try {
    const checkout = await bridge.checkout("https://billing.example/activate");
    assert.deepEqual(await bridge.retrieve(checkout.token), {
      state: "pending",
    });
    assert.throws(
      () => bridge.accept(Buffer.from("{}"), "0".repeat(64)),
      /signature/,
    );
    accept(bridge, "subscription_created", sub(), { device_deck_claim: claim });
    await bridge.drain();
    assert.deepEqual(await bridge.retrieve(checkout.token), {
      state: "ready",
      key: "PRIVATE-KEY",
    });
    assert.equal(
      bridge.db.prepare("SELECT subscription FROM claims").get()?.subscription,
      "123",
    );
    await assert.rejects(bridge.retrieve("wrong-token"), /Invalid/);
    clock += 86400001;
    await assert.rejects(bridge.retrieve(checkout.token), /expired/);
  } finally {
    bridge.close();
  }
});
test("full refunds hold access across lifecycle replay; partial refunds review; explicit release restores term", async () => {
  let refunds: { resource: string; partial: boolean }[] = [],
    expiry = 0;
  const bridge = new BillingBridge(
    ":memory:",
    { ...config, bindings: [{ subscriptionId: "123", licenseId: "license" }] },
    secret,
    {
      ...providers(),
      refunds: async () => refunds,
      updateLicense: async (_l, _s, value) => {
        expiry = value;
      },
    },
    () => now,
  );
  try {
    await bridge.reconcile("123");
    assert.ok(expiry > now);
    refunds = [{ resource: "subscription-invoices:4", partial: true }];
    await bridge.reconcile("123");
    assert.ok(expiry > now);
    assert.equal(bridge.status().holds[0].state, "review");
    refunds[0].partial = false;
    await bridge.reconcile("123");
    assert.equal(expiry, now);
    assert.deepEqual(
      await bridge.retrieve(bridge.retrievalGrant("123").token),
      { state: "held" },
    );
    await bridge.reconcile("123");
    assert.equal(expiry, now);
    bridge.releaseHold(
      "subscription-invoices:4",
      "Refund reviewed: retain access",
    );
    await bridge.drain();
    assert.ok(expiry > now);
    await bridge.reconcile("123");
    assert.ok(
      expiry > now,
      "Repeated refunded API state must not undo an explicit release",
    );
  } finally {
    bridge.close();
  }
});
test("payment webhooks reconcile current scope and reject wrong payloads without granting access", async () => {
  const p = providers(),
    bridge = new BillingBridge(":memory:", config, secret, p, () => now);
  try {
    const invoice = {
      id: "4",
      type: "subscription-invoices",
      attributes: { store_id: 1, test_mode: true, subscription_id: 123 },
    };
    accept(bridge, "subscription_payment_success", invoice);
    await bridge.drain();
    assert.equal(p.counts().ensures, 1);
    assert.throws(
      () => accept(bridge, "subscription_created", invoice),
      /Expected subscription/,
    );
    assert.throws(
      () =>
        accept(bridge, "subscription_payment_refunded", {
          ...invoice,
          attributes: { ...invoice.attributes, test_mode: false },
        }),
      /mode mismatch/,
    );
    assert.throws(() => accept(bridge, "chargeback_created", invoice));
  } finally {
    bridge.close();
  }
});
test("expired first observations never create a new license and operator holds require authoritative scope", async () => {
  const current = sub();
  current.attributes.status = "expired";
  current.attributes.ends_at = new Date(now - 1000).toISOString();
  const p = providers(),
    bridge = new BillingBridge(
      ":memory:",
      config,
      secret,
      { ...p, subscription: async () => current },
      () => now,
    );
  try {
    assert.equal(await bridge.reconcile("123"), "inactive");
    assert.equal(p.counts().ensures, 0);
    current.attributes.test_mode = false;
    await assert.rejects(
      bridge.hold("123", "case-1", "Dispute reported"),
      /mode mismatch/,
    );
    assert.equal(bridge.status().holds.length, 0);
  } finally {
    bridge.close();
  }
});
test("Keygen creates/reuses customers and recovers an ambiguous license creation using the same unique key", async () => {
  let user: any,
    license: any,
    creates = 0;
  const requests: { url: string; body: any }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input),
      method = init?.method || "GET",
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (url.includes("/licenses?"))
      return Response.json({ data: license ? [license] : [] });
    if (url.endsWith("/policies/pro"))
      return Response.json({
        data: {
          type: "policies",
          id: "pro",
          attributes: { scheme: null, transferStrategy: "KEEP_EXPIRY" },
          relationships: { product: { data: { id: "product" } } },
        },
      });
    if (url.includes("/users/") && method === "GET")
      return user
        ? Response.json({ data: user })
        : Response.json({}, { status: 404 });
    if (url.endsWith("/users") && method === "POST") {
      user = { ...body.data, id: "user" };
      return Response.json({ data: user });
    }
    if (url.includes("/licenses/DECK-") && method === "GET")
      return license
        ? Response.json({ data: license })
        : Response.json({}, { status: 404 });
    if (url.endsWith("/licenses") && method === "POST") {
      creates++;
      license = {
        ...body.data,
        id: "license",
        relationships: {
          ...body.data.relationships,
          product: { data: { id: "product" } },
        },
      };
      throw new TypeError("Response lost after server accepted license");
    }
    throw new Error("Unexpected test request");
  };
  const provider = new RemoteBillingProviders(
    config,
    "lemon-test",
    "keygen-test",
    transport,
    "stable-test-issuance-secret-never-use-in-production",
  );
  assert.equal(
    await provider.ensureLicense(sub(), now + 86400000, false),
    "license",
  );
  assert.equal(
    await provider.ensureLicense(sub(), now + 86400000, false),
    "license",
  );
  assert.equal(creates, 1);
  assert.equal(user.attributes.password, null);
  assert.deepEqual(user.attributes.permissions, []);
  assert.match(license.attributes.key, /^DECK-[A-F0-9]{64}$/);
  assert.equal(
    requests.filter((r) => r.body?.data?.type === "users").length,
    1,
  );
  license.relationships.product.data.id = "another-product";
  await assert.rejects(
    provider.ensureLicense(sub(), now + 86400000, false),
    /not bound/,
  );
});
test("HTTP checkout uses a private cookie; retrieval/admin routes reject guessed credentials and cross-origin requests", async () => {
  const p = {
    ...providers(),
    createCheckout: async () => "https://store.lemonsqueezy.com/checkout/test",
  };
  const bridge = new BillingBridge(":memory:", config, secret, p, () => now);
  let origin = "http://127.0.0.1";
  // Use a reserved local listener to get a concrete origin before creating the app server.
  const net = await import("node:net"),
    reservation = net.createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  origin += `:${port}`;
  const server = billingServer({
    bridge,
    publicUrl: origin,
    adminSecret: "test-admin-secret-at-least-thirty-two-characters",
    wake() {},
    ready: () => true,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const denied = await fetch(`${origin}/checkout`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    assert.equal((await fetch(`${origin}/admin/status`)).status, 401);
    const checkout = await fetch(`${origin}/checkout`, {
      method: "POST",
      headers: { Origin: origin },
      body: "{}",
    });
    assert.equal(checkout.status, 200);
    const cookie = checkout.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; SameSite=Lax/);
    assert.equal(checkout.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(await checkout.json()), ["url"]);
    const pending = await fetch(`${origin}/license`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie.split(";")[0] },
      body: "{}",
    });
    assert.deepEqual(await pending.json(), { state: "pending" });
    const invalid = await fetch(`${origin}/license`, {
      method: "POST",
      headers: { Origin: origin },
      body: "{}",
    });
    assert.equal(invalid.status, 401);
    assert.equal((await fetch(`${origin}/readyz`)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bridge.close();
  }
});
test("worker transaction lock excludes another process and automatically recovers after its crash", async () => {
  const { spawn } = await import("node:child_process");
  const { acquireWorkerLock } = await import("./lock");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "deck-billing-crash-"),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {acquireWorkerLock} from ${JSON.stringify(new URL("./lock.ts", import.meta.url).href)}; acquireWorkerLock(process.argv[1]); console.log('locked'); setInterval(()=>{},1000);`,
      directory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code) reject(new Error(`Worker failed: ${code}`));
      });
    });
    assert.throws(() => acquireWorkerLock(directory), /live worker/);
    const ended = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await ended;
    const release = acquireWorkerLock(directory);
    release();
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
test("provider refund pagination validates every invoice's ownership before returning a hold", async () => {
  let mismatch = false;
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/9"))
      return Response.json({
        data: {
          type: "orders",
          id: "9",
          attributes: {
            store_id: 1,
            test_mode: true,
            customer_id: 99,
            refunded: false,
            refunded_amount: 0,
            status: "paid",
          },
        },
      });
    const page = Number(url.searchParams.get("page[number]"));
    assert.equal(url.searchParams.get("filter[subscription_id]"), "123");
    return Response.json({
      meta: { page: { lastPage: 2 } },
      data: [
        {
          type: "subscription-invoices",
          id: String(page),
          attributes: {
            store_id: 1,
            test_mode: true,
            subscription_id: mismatch && page === 2 ? 999 : 123,
            refunded: page === 2,
            refunded_amount: page === 2 ? 999 : 0,
            status: page === 2 ? "refunded" : "paid",
          },
        },
      ],
    });
  };
  const provider = new RemoteBillingProviders(
    config,
    "lemon-test",
    "keygen-test",
    transport,
  );
  assert.deepEqual(await provider.refunds(sub()), [
    { resource: "subscription-invoices:2", partial: false },
  ]);
  mismatch = true;
  await assert.rejects(provider.refunds(sub()), /subscription mismatch/);
});
