import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
} from "node:crypto";
import { chmodSync } from "node:fs";
import { z } from "zod";
import { SerialQueue } from "../../../packages/config/src";
const id = z.string().regex(/^[A-Za-z0-9-]+$/);
export const billingConfigSchema = z
  .object({
    storeId: z.number().int().positive(),
    productId: z.number().int().positive(),
    variantId: z.number().int().positive(),
    testMode: z.boolean(),
    keygenAccountId: id,
    keygenProductId: id,
    keygenProPolicyId: id,
    keygenTrialPolicyId: id.optional(),
    bindings: z
      .array(z.object({ subscriptionId: id, licenseId: id }).strict())
      .default([]),
  })
  .strict();
export type BillingConfig = z.infer<typeof billingConfigSchema>;
export const subscriptionSchema = z.object({
  type: z.literal("subscriptions"),
  id,
  attributes: z.object({
    store_id: z.number(),
    product_id: z.number(),
    variant_id: z.number(),
    test_mode: z.boolean(),
    customer_id: z.number().int().positive().optional(),
    order_id: z.number().int().positive().optional(),
    user_email: z.string().email().optional(),
    user_name: z.string().optional(),
    updated_at: z.string(),
    status: z.enum([
      "active",
      "on_trial",
      "cancelled",
      "expired",
      "past_due",
      "unpaid",
      "paused",
    ]),
    renews_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    trial_ends_at: z.string().nullable(),
    pause: z
      .object({
        mode: z.enum(["free", "void"]),
        resumes_at: z.string().nullable(),
      })
      .nullable(),
  }),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
const time = (value: string | null) => {
  const n = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(n))
    throw new Error("Missing authoritative subscription date");
  return n;
};
type Ledger = {
  updated: number;
  paidThrough: number;
  appliedExpiry: number;
  trial?: boolean;
};
export function desiredAccess(
  s: Subscription,
  previous: Ledger | undefined,
  now: number,
) {
  const a = s.attributes,
    updated = time(a.updated_at);
  if (previous && updated < previous.updated)
    return { ...previous, stale: true };
  let paidThrough = previous?.paidThrough || 0,
    expiry = now,
    trial = previous?.trial || false;
  switch (a.status) {
    case "active":
      trial = false;
      if (a.pause !== null)
        throw new Error("Active subscription has inconsistent pause state");
      expiry = paidThrough = time(a.renews_at);
      break;
    case "cancelled":
      expiry = paidThrough = time(a.ends_at);
      break;
    case "expired":
      expiry = Math.min(now, time(a.ends_at));
      break;
    case "on_trial":
      expiry = time(a.trial_ends_at);
      trial = true;
      break;
    case "past_due":
    case "unpaid":
      expiry = paidThrough || now;
      break;
    case "paused":
      if (!a.pause)
        throw new Error("Paused subscription lacks its pause policy");
      // A free pause is an explicit issuer-side complimentary service period.
      // Reconcile hourly; each grant is capped at one day. Void grants no new time.
      expiry =
        a.pause.mode === "free"
          ? Math.max(
              paidThrough,
              Math.min(
                now + 86400000,
                a.pause.resumes_at
                  ? Math.max(now, time(a.pause.resumes_at))
                  : now + 86400000,
              ),
            )
          : paidThrough || now;
      break;
  }
  if (expiry > now + 400 * 86400000)
    throw new Error("Subscription exceeds the supported monthly/annual term");
  return { stale: false, updated, paidThrough, appliedExpiry: expiry, trial };
}
export interface BillingProviders {
  subscription(id: string): Promise<unknown>;
  ensureLicense?(
    subscription: Subscription,
    expiry: number,
    trial: boolean,
  ): Promise<string>;
  refunds?(
    subscription: Subscription,
  ): Promise<{ resource: string; partial: boolean }[]>;
  orderSubscriptions?(orderId: string): Promise<string[]>;
  createCheckout?(
    claimId: string,
    returnUrl: string,
    expires: number,
  ): Promise<string>;
  licenseKey?(licenseId: string, subscriptionId: string): Promise<string>;
  updateLicense(
    licenseId: string,
    subscriptionId: string,
    expiry: number,
    trial: boolean,
  ): Promise<void>;
}
export const webhookEvents = [
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
  "subscription_payment_success",
  "subscription_payment_failed",
  "subscription_payment_recovered",
  "subscription_payment_refunded",
  "order_refunded",
] as const;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Binding = { subscription: string; license: string };
type Claim = { id: string; subscription: string | null; expires: number };
export class BillingBridge {
  readonly db: DatabaseSync;
  private queue = new SerialQueue();
  constructor(
    file: string,
    readonly config: BillingConfig,
    private secret: string,
    private providers: BillingProviders,
    private now = Date.now,
  ) {
    billingConfigSchema.parse(config);
    if (secret.length < 16)
      throw new Error("Use a webhook secret of at least 16 characters");
    if (
      new Set(config.bindings.map((b) => b.subscriptionId)).size !==
        config.bindings.length ||
      new Set(config.bindings.map((b) => b.licenseId)).size !==
        config.bindings.length
    )
      throw new Error("Billing bindings must be one-to-one");
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(digest TEXT PRIMARY KEY, subscription TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ledger(subscription TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(subscription TEXT PRIMARY KEY, license TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, subscription TEXT, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS holds(resource TEXT PRIMARY KEY, subscription TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, subscription TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_retry ON events(state,retry_at);
      CREATE INDEX IF NOT EXISTS claim_expiry ON claims(expires);
    `);
    const columns = this.db
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((c) => c.name);
    if (!columns.includes("kind"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'subscription'",
      );
    if (!columns.includes("claim"))
      this.db.exec("ALTER TABLE events ADD COLUMN claim TEXT");
    // One database cannot be accidentally repointed at another environment/product.
    const scope = JSON.stringify([
      config.storeId,
      config.productId,
      config.variantId,
      config.testMode,
      config.keygenAccountId,
      config.keygenProductId,
      config.keygenProPolicyId,
      config.keygenTrialPolicyId,
    ]);
    const saved = this.db
      .prepare("SELECT config FROM identity WHERE id=1")
      .get();
    if (saved && saved.config !== scope) {
      this.db.close();
      throw new Error(
        "Billing database identity differs from configured scope",
      );
    }
    this.db
      .prepare("INSERT OR IGNORE INTO identity(id,config) VALUES(1,?)")
      .run(scope);
    for (const b of config.bindings) {
      const existing = this.binding(b.subscriptionId);
      if (existing && existing.license !== b.licenseId)
        throw new Error(
          "Configured binding conflicts with durable billing identity",
        );
      const other = this.db
        .prepare("SELECT subscription FROM bindings WHERE license=?")
        .get(b.licenseId);
      if (other && other.subscription !== b.subscriptionId)
        throw new Error(
          "Configured license is already bound to another subscription",
        );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO bindings(subscription,license) VALUES(?,?)",
        )
        .run(b.subscriptionId, b.licenseId);
    }
  }
  private binding(subscription: string) {
    return this.db
      .prepare("SELECT * FROM bindings WHERE subscription=?")
      .get(subscription) as Binding | undefined;
  }
  accept(raw: Buffer, signature: string) {
    if (raw.length > 256 * 1024 || !/^[a-f0-9]{64}$/i.test(signature))
      throw new Error("Invalid webhook signature or size");
    const expected = createHmac("sha256", this.secret).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
      throw new Error("Invalid webhook signature");
    const event = z
      .object({
        meta: z.object({
          event_name: z.enum(webhookEvents),
          custom_data: z
            .object({
              device_deck_claim: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
            })
            .passthrough()
            .optional(),
        }),
        data: z.object({
          type: z.enum(["subscriptions", "subscription-invoices", "orders"]),
          id,
          attributes: z
            .object({ store_id: z.number(), test_mode: z.boolean() })
            .passthrough(),
        }),
      })
      .parse(JSON.parse(raw.toString("utf8")));
    const a = event.data.attributes;
    this.matchesStore(a);
    let subscription = event.data.id,
      kind = "subscription";
    if (event.meta.event_name === "order_refunded") {
      if (event.data.type !== "orders")
        throw new Error("Expected order refund object");
      kind = "order";
    } else if (event.meta.event_name.startsWith("subscription_payment_")) {
      if (event.data.type !== "subscription-invoices")
        throw new Error("Expected subscription invoice object");
      subscription = String(
        z.number().int().positive().parse(a.subscription_id),
      );
    } else {
      if (event.data.type !== "subscriptions")
        throw new Error("Expected subscription object");
      this.matches(
        z
          .object({
            store_id: z.number(),
            test_mode: z.boolean(),
            product_id: z.number(),
            variant_id: z.number(),
          })
          .parse(a),
      );
    }
    const digest = createHash("sha256").update(raw).digest("hex");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO events(digest,subscription,state,kind,claim) VALUES(?,?,'pending',?,?)",
      )
      .run(
        digest,
        subscription,
        kind,
        event.meta.event_name === "subscription_created"
          ? event.meta.custom_data?.device_deck_claim || null
          : null,
      );
    return { accepted: true, digest };
  }
  private matchesStore(a: { store_id: number; test_mode: boolean }) {
    if (
      a.store_id !== this.config.storeId ||
      a.test_mode !== this.config.testMode
    )
      throw new Error(
        "Webhook/provider store, product, variant or test mode mismatch",
      );
  }
  private matches(a: {
    store_id: number;
    product_id: number;
    variant_id: number;
    test_mode: boolean;
  }) {
    this.matchesStore(a);
    if (
      a.product_id !== this.config.productId ||
      a.variant_id !== this.config.variantId
    )
      throw new Error(
        "Webhook/provider store, product, variant or test mode mismatch",
      );
  }
  private audit(subscription: string, action: string, detail: string) {
    this.db
      .prepare(
        "INSERT INTO audit(at,subscription,action,detail) VALUES(?,?,?,?)",
      )
      .run(this.now(), subscription, action, detail);
  }
  private held(subscription: string) {
    return (
      this.db
        .prepare(
          "SELECT resource FROM holds WHERE subscription=? AND state='active'",
        )
        .all(subscription).length > 0
    );
  }
  reconcile(subscriptionId: string) {
    id.parse(subscriptionId);
    return this.queue.run(async () => {
      const current = subscriptionSchema.parse(
        await this.providers.subscription(subscriptionId),
      );
      if (current.id !== subscriptionId)
        throw new Error("Provider returned a different subscription");
      this.matches(current.attributes);
      const previous = this.db
        .prepare("SELECT payload FROM ledger WHERE subscription=?")
        .get(subscriptionId) as { payload: string } | undefined;
      const prior = previous ? JSON.parse(previous.payload) : undefined;
      const desired = desiredAccess(current, prior, this.now());
      // Always inspect authoritative refunds, even if the lifecycle timestamp has not changed.
      for (const refund of (await this.providers.refunds?.(current)) || []) {
        const inserted = this.db
          .prepare(
            "INSERT OR IGNORE INTO holds(resource,subscription,reason,state,created) VALUES(?,?,?,?,?)",
          )
          .run(
            refund.resource,
            subscriptionId,
            refund.partial
              ? "Partial refund: review"
              : "Full refund: access held pending review",
            refund.partial ? "review" : "active",
            this.now(),
          );
        if (inserted.changes)
          this.audit(subscriptionId, "refund", refund.resource);
        // A partial refund can subsequently become a full refund. Explicitly released holds remain released.
        if (!refund.partial)
          this.db
            .prepare(
              "UPDATE holds SET state='active',reason='Full refund: access held pending review' WHERE resource=? AND state='review'",
            )
            .run(refund.resource);
      }
      const held = this.held(subscriptionId);
      if (desired.stale && !held) return "stale" as const;
      if (held)
        desired.appliedExpiry = Math.min(
          prior?.appliedExpiry || this.now(),
          this.now(),
        );
      let binding = this.binding(subscriptionId);
      if (!binding) {
        if (!this.providers.ensureLicense) return "awaiting-issuer" as const;
        if (desired.appliedExpiry <= this.now()) return "inactive" as const;
        const license = await this.providers.ensureLicense(
          current,
          desired.appliedExpiry,
          "trial" in desired && Boolean(desired.trial),
        );
        id.parse(license);
        this.db
          .prepare("INSERT INTO bindings(subscription,license) VALUES(?,?)")
          .run(subscriptionId, license);
        binding = { subscription: subscriptionId, license };
        this.audit(subscriptionId, "license-bound", license);
      }
      if (
        prior &&
        prior.appliedExpiry === desired.appliedExpiry &&
        prior.updated === desired.updated &&
        Boolean(prior.trial) === Boolean(desired.trial) &&
        prior.held === held
      )
        return "unchanged" as const;
      await this.providers.updateLicense(
        binding.license,
        subscriptionId,
        desired.appliedExpiry,
        "trial" in desired && Boolean(desired.trial),
      );
      this.db
        .prepare(
          "INSERT INTO ledger(subscription,payload) VALUES(?,?) ON CONFLICT(subscription) DO UPDATE SET payload=excluded.payload",
        )
        .run(subscriptionId, JSON.stringify({ ...desired, held }));
      this.audit(
        subscriptionId,
        "access-reconciled",
        new Date(desired.appliedExpiry).toISOString(),
      );
      return "applied" as const;
    });
  }
  async drain() {
    const pending = this.db
      .prepare(
        "SELECT digest,subscription,attempts,kind,claim FROM events WHERE state != 'applied' AND retry_at <= ? ORDER BY rowid LIMIT 100",
      )
      .all(this.now()) as {
      digest: string;
      subscription: string;
      attempts: number;
      kind: string;
      claim: string | null;
    }[];
    for (const e of pending) {
      try {
        const ids =
          e.kind === "order"
            ? await this.providers.orderSubscriptions?.(e.subscription)
            : [e.subscription];
        if (!ids) throw new Error("Order provider unavailable");
        let awaiting = false;
        for (const subscription of ids) {
          const result = await this.reconcile(subscription);
          awaiting ||= result === "awaiting-issuer";
          if (e.claim && !awaiting) {
            const claim = this.db
              .prepare("SELECT subscription FROM claims WHERE id=?")
              .get(e.claim);
            if (claim?.subscription && claim.subscription !== subscription)
              throw new Error(
                "Checkout claim is already bound to another subscription",
              );
            this.db
              .prepare(
                "UPDATE claims SET subscription=? WHERE id=? AND subscription IS NULL",
              )
              .run(subscription, e.claim);
          }
        }
        this.db
          .prepare("UPDATE events SET state=?,retry_at=? WHERE digest=?")
          .run(
            awaiting ? "awaiting-issuer" : "applied",
            awaiting ? this.now() + 60000 : 0,
            e.digest,
          );
      } catch {
        this.db
          .prepare(
            "UPDATE events SET state='retry',attempts=attempts+1,retry_at=? WHERE digest=?",
          )
          .run(
            this.now() +
              Math.min(3600000, 30000 * 2 ** Math.min(e.attempts, 7)),
            e.digest,
          );
      }
    }
  }
  subscriptions() {
    return (
      this.db
        .prepare(
          "SELECT subscription FROM bindings UNION SELECT subscription FROM events WHERE kind='subscription'",
        )
        .all() as { subscription: string }[]
    ).map((b) => b.subscription);
  }
  enqueue(subscription: string) {
    id.parse(subscription);
    this.db
      .prepare(
        "INSERT INTO events(digest,subscription,state) VALUES(?,?,'pending')",
      )
      .run(randomBytes(32).toString("hex"), subscription);
  }
  private newClaim(subscription: string | null, duration: number) {
    this.db.prepare("DELETE FROM claims WHERE expires<=?").run(this.now());
    const claimId = randomBytes(32).toString("hex"),
      token = randomBytes(32).toString("base64url"),
      expires = this.now() + duration;
    this.db
      .prepare(
        "INSERT INTO claims(id,digest,subscription,expires) VALUES(?,?,?,?)",
      )
      .run(claimId, hash(token), subscription, expires);
    return { claimId, token, expires };
  }
  async checkout(returnUrl: string) {
    if (!this.providers.createCheckout)
      throw new Error("Checkout provider unavailable");
    const claim = this.newClaim(null, 86400000);
    try {
      const url = await this.providers.createCheckout(
        claim.claimId,
        returnUrl,
        this.now() + 3600000,
      );
      return { ...claim, url };
    } catch (e) {
      this.db.prepare("DELETE FROM claims WHERE id=?").run(claim.claimId);
      throw e;
    }
  }
  retrievalGrant(subscription: string) {
    id.parse(subscription);
    if (!this.binding(subscription))
      throw new Error("No issued license for this subscription");
    this.audit(
      subscription,
      "retrieval-grant",
      "Operator created 30-minute retrieval link",
    );
    return this.newClaim(subscription, 30 * 60000);
  }
  async retrieve(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("Invalid or expired retrieval token");
    const claim = this.db
      .prepare(
        "SELECT id,subscription,expires FROM claims WHERE digest=? AND expires>?",
      )
      .get(hash(token), this.now()) as Claim | undefined;
    if (!claim) throw new Error("Invalid or expired retrieval token");
    if (!claim.subscription) return { state: "pending" as const };
    if (this.held(claim.subscription)) return { state: "held" as const };
    const binding = this.binding(claim.subscription);
    if (!binding) return { state: "pending" as const };
    if (!this.providers.licenseKey)
      throw new Error("License retrieval unavailable");
    const key = await this.providers.licenseKey(
      binding.license,
      claim.subscription,
    );
    return { state: "ready" as const, key };
  }
  async hold(subscription: string, reference: string, reason: string) {
    id.parse(subscription);
    id.parse(reference);
    z.string().trim().min(3).max(240).parse(reason);
    // Validate the authoritative scope before recording an operator hold.
    const current = subscriptionSchema.parse(
      await this.providers.subscription(subscription),
    );
    if (current.id !== subscription)
      throw new Error("Provider returned a different subscription");
    this.matches(current.attributes);
    const resource = `operator:${reference}`;
    const existing = this.db
      .prepare("SELECT subscription FROM holds WHERE resource=?")
      .get(resource);
    if (existing && existing.subscription !== subscription)
      throw new Error("Case reference belongs to another subscription");
    this.db
      .prepare(
        "INSERT INTO holds(resource,subscription,reason,state,created) VALUES(?,?,?,'active',?) ON CONFLICT(resource) DO UPDATE SET state='active',reason=excluded.reason WHERE holds.subscription=excluded.subscription",
      )
      .run(resource, subscription, reason, this.now());
    this.audit(subscription, "operator-hold", reference);
    this.enqueue(subscription);
  }
  releaseHold(resource: string, reason: string) {
    z.string().trim().min(3).max(240).parse(reason);
    const row = this.db
      .prepare("SELECT subscription FROM holds WHERE resource=?")
      .get(resource) as { subscription: string } | undefined;
    if (!row) throw new Error("Hold not found");
    this.db
      .prepare("UPDATE holds SET state='released' WHERE resource=?")
      .run(resource);
    this.audit(row.subscription, "hold-released", `${resource}: ${reason}`);
    this.enqueue(row.subscription);
  }
  pending() {
    return this.db
      .prepare(
        "SELECT subscription,state,attempts FROM events WHERE state != 'applied'",
      )
      .all();
  }
  status() {
    return {
      pending: this.pending(),
      holds: this.db
        .prepare("SELECT * FROM holds WHERE state IN ('active','review')")
        .all(),
      bindings: this.db.prepare("SELECT * FROM bindings").all(),
    };
  }
  close() {
    this.db.close();
  }
}
export { RemoteBillingProviders } from "./providers";
