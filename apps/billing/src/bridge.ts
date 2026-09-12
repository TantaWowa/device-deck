import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
type Ledger = { updated: number; paidThrough: number; appliedExpiry: number };
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
    trial = false;
  switch (a.status) {
    case "active":
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
  updateLicense(
    licenseId: string,
    subscriptionId: string,
    expiry: number,
    trial: boolean,
  ): Promise<void>;
}
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
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events(digest TEXT PRIMARY KEY, subscription TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS ledger(subscription TEXT PRIMARY KEY, payload TEXT NOT NULL);",
    );
  }
  accept(raw: Buffer, signature: string) {
    if (raw.length > 256 * 1024 || !/^[a-f0-9]{64}$/i.test(signature))
      throw new Error("Invalid webhook signature or size");
    const expected = createHmac("sha256", this.secret).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
      throw new Error("Invalid webhook signature");
    const event = z
      .object({
        meta: z.object({ event_name: z.string() }),
        data: z.object({
          type: z.literal("subscriptions"),
          id,
          attributes: z
            .object({
              store_id: z.number(),
              product_id: z.number(),
              variant_id: z.number(),
              test_mode: z.boolean(),
            })
            .passthrough(),
        }),
      })
      .parse(JSON.parse(raw.toString("utf8")));
    if (
      ![
        "subscription_created",
        "subscription_updated",
        "subscription_cancelled",
        "subscription_resumed",
        "subscription_expired",
        "subscription_paused",
        "subscription_unpaused",
      ].includes(event.meta.event_name)
    )
      throw new Error(
        "Unsupported webhook event; subscribe to subscription lifecycle events",
      );
    this.matches(event.data.attributes);
    const digest = createHash("sha256").update(raw).digest("hex");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO events(digest,subscription,state) VALUES(?,?,'pending')",
      )
      .run(digest, event.data.id);
    return { accepted: true, digest };
  }
  private matches(a: {
    store_id: number;
    product_id: number;
    variant_id: number;
    test_mode: boolean;
  }) {
    if (
      a.store_id !== this.config.storeId ||
      a.product_id !== this.config.productId ||
      a.variant_id !== this.config.variantId ||
      a.test_mode !== this.config.testMode
    )
      throw new Error(
        "Webhook/provider store, product, variant or test mode mismatch",
      );
  }
  reconcile(subscriptionId: string) {
    return this.queue.run(async () => {
      const current = subscriptionSchema.parse(
        await this.providers.subscription(subscriptionId),
      );
      if (current.id !== subscriptionId)
        throw new Error("Provider returned a different subscription");
      this.matches(current.attributes);
      const binding = this.config.bindings.find(
        (b) => b.subscriptionId === subscriptionId,
      );
      if (!binding) return "awaiting-issuer" as const;
      const previous = this.db
        .prepare("SELECT payload FROM ledger WHERE subscription=?")
        .get(subscriptionId) as { payload: string } | undefined;
      const desired = desiredAccess(
        current,
        previous ? JSON.parse(previous.payload) : undefined,
        this.now(),
      );
      if (desired.stale) return "stale" as const;
      if (
        previous &&
        JSON.parse(previous.payload).appliedExpiry === desired.appliedExpiry &&
        JSON.parse(previous.payload).updated === desired.updated
      )
        return "unchanged" as const;
      await this.providers.updateLicense(
        binding.licenseId,
        subscriptionId,
        desired.appliedExpiry,
        desired.trial || false,
      );
      this.db
        .prepare(
          "INSERT INTO ledger(subscription,payload) VALUES(?,?) ON CONFLICT(subscription) DO UPDATE SET payload=excluded.payload",
        )
        .run(subscriptionId, JSON.stringify(desired));
      return "applied" as const;
    });
  }
  async drain() {
    const pending = this.db
      .prepare(
        "SELECT digest,subscription,attempts FROM events WHERE state != 'applied' AND retry_at <= ?",
      )
      .all(this.now()) as {
      digest: string;
      subscription: string;
      attempts: number;
    }[];
    for (const e of pending) {
      try {
        const result = await this.reconcile(e.subscription);
        this.db
          .prepare("UPDATE events SET state=?,retry_at=? WHERE digest=?")
          .run(
            result === "awaiting-issuer" ? result : "applied",
            result === "awaiting-issuer" ? this.now() + 60000 : 0,
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
  pending() {
    return this.db
      .prepare(
        "SELECT subscription,state,attempts FROM events WHERE state != 'applied'",
      )
      .all();
  }
  close() {
    this.db.close();
  }
}
export class RemoteBillingProviders implements BillingProviders {
  constructor(
    private config: BillingConfig,
    private lemonToken: string,
    private keygenToken: string,
    private transport: typeof fetch = fetch,
  ) {}
  private async request(
    url: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) {
    const res = await this.transport(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`Provider request failed (${res.status})`);
    const result = await res.json();
    if (result.errors) throw new Error("Provider returned errors");
    return result.data;
  }
  subscription(id: string) {
    return this.request(
      `https://api.lemonsqueezy.com/v1/subscriptions/${encodeURIComponent(id)}`,
      this.lemonToken,
    );
  }
  async updateLicense(
    licenseId: string,
    subscriptionId: string,
    expiry: number,
    trial: boolean,
  ) {
    const url = `https://api.keygen.sh/v1/accounts/${encodeURIComponent(this.config.keygenAccountId)}/licenses/${encodeURIComponent(licenseId)}`;
    const license = await this.request(url, this.keygenToken);
    const policy = trial
      ? this.config.keygenTrialPolicyId
      : this.config.keygenProPolicyId;
    const currentPolicy = license?.relationships?.policy?.data?.id;
    const converting =
      !trial &&
      currentPolicy === this.config.keygenTrialPolicyId &&
      Boolean(this.config.keygenTrialPolicyId);
    if (
      !policy ||
      license?.id !== licenseId ||
      license?.type !== "licenses" ||
      license.relationships?.product?.data?.id !==
        this.config.keygenProductId ||
      (currentPolicy !== policy && !converting) ||
      license.attributes?.metadata?.lemonSubscriptionId !== subscriptionId ||
      license.attributes?.metadata?.deviceDeckMode !==
        (this.config.testMode ? "test" : "live") ||
      license.attributes?.metadata?.lemonTestMode !== this.config.testMode
    )
      throw new Error(
        "Keygen license is not bound to this billing identity and mode",
      );
    if (converting) {
      const target = await this.request(
        `https://api.keygen.sh/v1/accounts/${encodeURIComponent(this.config.keygenAccountId)}/policies/${encodeURIComponent(policy)}`,
        this.keygenToken,
      );
      if (
        target?.id !== policy ||
        target?.type !== "policies" ||
        target.relationships?.product?.data?.id !==
          this.config.keygenProductId ||
        target.attributes?.transferStrategy !== "KEEP_EXPIRY"
      )
        throw new Error(
          "Pro conversion requires the pinned same-product policy with KEEP_EXPIRY",
        );
    }
    // Do not clear an operator's suspension or modify feature entitlements.
    await this.request(url, this.keygenToken, "PATCH", {
      data: {
        type: "licenses",
        id: licenseId,
        attributes: { expiry: new Date(expiry).toISOString() },
      },
    });
    if (converting)
      await this.request(`${url}/policy`, this.keygenToken, "PUT", {
        data: { type: "policies", id: policy },
      });
  }
}
