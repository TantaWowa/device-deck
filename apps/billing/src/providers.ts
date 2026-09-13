import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  subscriptionSchema,
  type BillingConfig,
  type BillingProviders,
  type Subscription,
} from "./bridge";
const id = z.string().regex(/^[A-Za-z0-9-]+$/);
class ProviderError extends Error {
  constructor(readonly status: number) {
    super(`Provider request failed (${status})`);
  }
}
const relation = (type: string, value: string) => ({
  data: { type, id: value },
});
export class RemoteBillingProviders implements BillingProviders {
  constructor(
    private config: BillingConfig,
    private lemonToken: string,
    private keygenToken: string,
    private transport: typeof fetch = fetch,
    private issuanceSecret?: string,
  ) {
    if (issuanceSecret !== undefined && issuanceSecret.length < 32)
      throw new Error("Use an issuance secret of at least 32 characters");
  }
  async preflight() {
    const [product, lemonProduct, variant] = await Promise.all([
      this.request(
        this.keygen(
          `products/${encodeURIComponent(this.config.keygenProductId)}`,
        ),
        this.keygenToken,
      ),
      this.request(
        `https://api.lemonsqueezy.com/v1/products/${this.config.productId}`,
        this.lemonToken,
      ),
      this.request(
        `https://api.lemonsqueezy.com/v1/variants/${this.config.variantId}`,
        this.lemonToken,
      ),
    ]);
    if (
      product?.type !== "products" ||
      product?.id !== this.config.keygenProductId ||
      product.attributes?.metadata?.deviceDeckMode !==
        (this.config.testMode ? "test" : "live")
    )
      throw new Error("Keygen product environment mismatch");
    if (
      lemonProduct?.type !== "products" ||
      lemonProduct?.id !== String(this.config.productId) ||
      lemonProduct.attributes?.store_id !== this.config.storeId ||
      variant?.type !== "variants" ||
      variant?.id !== String(this.config.variantId) ||
      variant.attributes?.product_id !== this.config.productId
    )
      throw new Error("Lemon Squeezy store/product/variant mismatch");
    await this.policy(false);
    if (this.config.keygenTrialPolicyId) await this.policy(true);
  }
  private keygen(resource: string) {
    return `https://api.keygen.sh/v1/accounts/${encodeURIComponent(this.config.keygenAccountId)}/${resource}`;
  }
  private async response(
    url: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) {
    const res = await this.transport(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new ProviderError(res.status);
    if (res.status === 204) return { data: null };
    const result = await res.json();
    if (result.errors) throw new Error("Provider returned errors");
    return result;
  }
  private async request(
    url: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) {
    return (await this.response(url, token, method, body)).data;
  }
  private async optional(url: string, token: string) {
    try {
      return await this.request(url, token);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return undefined;
      throw e;
    }
  }
  private async lemonList(resource: string, filters: Record<string, string>) {
    const result: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({
        "page[number]": String(page),
        "page[size]": "100",
      });
      for (const [key, value] of Object.entries(filters))
        query.set(`filter[${key}]`, value);
      const response = await this.response(
        `https://api.lemonsqueezy.com/v1/${resource}?${query}`,
        this.lemonToken,
      );
      if (!Array.isArray(response.data))
        throw new Error("Malformed provider collection");
      result.push(...response.data);
      const lastPage = z
        .number()
        .int()
        .positive()
        .parse(response.meta?.page?.lastPage);
      if (page >= lastPage) return result;
    }
    throw new Error("Billing collection exceeds the supported page limit");
  }
  private matchesStore(a: any) {
    if (
      a?.store_id !== this.config.storeId ||
      a?.test_mode !== this.config.testMode
    )
      throw new Error("Provider store or test mode mismatch");
  }
  private matchesSubscription(s: Subscription) {
    this.matchesStore(s.attributes);
    if (
      s.attributes.product_id !== this.config.productId ||
      s.attributes.variant_id !== this.config.variantId
    )
      throw new Error("Provider product or variant mismatch");
  }
  subscription(value: string) {
    id.parse(value);
    return this.request(
      `https://api.lemonsqueezy.com/v1/subscriptions/${encodeURIComponent(value)}`,
      this.lemonToken,
    );
  }
  async orderSubscriptions(orderId: string) {
    id.parse(orderId);
    const order = await this.request(
      `https://api.lemonsqueezy.com/v1/orders/${encodeURIComponent(orderId)}`,
      this.lemonToken,
    );
    if (order?.id !== orderId || order?.type !== "orders")
      throw new Error("Provider returned a different order");
    this.matchesStore(order.attributes);
    const subscriptions = await this.lemonList("subscriptions", {
      store_id: String(this.config.storeId),
      product_id: String(this.config.productId),
      variant_id: String(this.config.variantId),
      order_id: orderId,
    });
    return subscriptions.map((value) => {
      const s = subscriptionSchema.parse(value);
      this.matchesSubscription(s);
      if (String(s.attributes.order_id) !== orderId)
        throw new Error("Provider returned another order's subscription");
      return s.id;
    });
  }
  async refunds(s: Subscription) {
    this.matchesSubscription(s);
    const orderId = z.number().int().positive().parse(s.attributes.order_id);
    const [order, invoices] = await Promise.all([
      this.request(
        `https://api.lemonsqueezy.com/v1/orders/${orderId}`,
        this.lemonToken,
      ),
      this.lemonList("subscription-invoices", {
        store_id: String(this.config.storeId),
        subscription_id: s.id,
      }),
    ]);
    if (order?.type !== "orders" || order?.id !== String(orderId))
      throw new Error("Provider returned a different order");
    this.matchesStore(order.attributes);
    if (order.attributes.customer_id !== s.attributes.customer_id)
      throw new Error("Order customer mismatch");
    const refunds: { resource: string; partial: boolean }[] = [];
    for (const resource of [order, ...invoices]) {
      this.matchesStore(resource.attributes);
      if (
        resource.type === "subscription-invoices" &&
        String(resource.attributes.subscription_id) !== s.id
      )
        throw new Error("Invoice subscription mismatch");
      if (resource !== order && resource.type !== "subscription-invoices")
        throw new Error("Unexpected invoice type");
      const a = z
        .object({
          status: z.string(),
          refunded: z.boolean(),
          refunded_amount: z.number().nonnegative(),
        })
        .parse(resource.attributes);
      if (
        a.refunded ||
        a.status === "refunded" ||
        a.refunded_amount > 0 ||
        a.status === "partial_refund"
      )
        refunds.push({
          resource: `${resource.type}:${id.parse(resource.id)}`,
          partial: !a.refunded && a.status !== "refunded",
        });
    }
    return refunds;
  }
  private async policy(trial: boolean) {
    const policy = trial
      ? this.config.keygenTrialPolicyId
      : this.config.keygenProPolicyId;
    if (!policy)
      throw new Error("No policy configured for this subscription state");
    const target = await this.request(
      this.keygen(`policies/${encodeURIComponent(policy)}`),
      this.keygenToken,
    );
    if (
      target?.id !== policy ||
      target?.type !== "policies" ||
      target.relationships?.product?.data?.id !== this.config.keygenProductId ||
      target.attributes?.scheme !== null ||
      target.attributes?.transferStrategy !== "KEEP_EXPIRY"
    )
      throw new Error(
        "Issuance requires the pinned same-product policy with opaque keys and KEEP_EXPIRY",
      );
    return policy;
  }
  private checkLicense(
    license: any,
    subscriptionId: string,
    licenseId?: string,
  ) {
    const policy = license?.relationships?.policy?.data?.id;
    if (
      !license ||
      license.type !== "licenses" ||
      (licenseId && license.id !== licenseId) ||
      license.relationships?.product?.data?.id !==
        this.config.keygenProductId ||
      ![this.config.keygenProPolicyId, this.config.keygenTrialPolicyId]
        .filter(Boolean)
        .includes(policy) ||
      license.attributes?.metadata?.lemonSubscriptionId !== subscriptionId ||
      license.attributes?.metadata?.deviceDeckMode !==
        (this.config.testMode ? "test" : "live") ||
      license.attributes?.metadata?.lemonTestMode !== this.config.testMode
    )
      throw new Error(
        "Keygen license is not bound to this billing identity and mode",
      );
    return license;
  }
  async ensureLicense(s: Subscription, expiry: number, trial: boolean) {
    this.matchesSubscription(s);
    if (!this.issuanceSecret || this.issuanceSecret.length < 32)
      throw new Error(
        "Automatic issuance needs a stable server secret of at least 32 characters",
      );
    const query = new URLSearchParams({
      product: this.config.keygenProductId,
      "metadata[lemonSubscriptionId]": s.id,
      "metadata[deviceDeckMode]": this.config.testMode ? "test" : "live",
      limit: "2",
    });
    const found = await this.request(
      this.keygen(`licenses?${query}`),
      this.keygenToken,
    );
    if (!Array.isArray(found) || found.length > 1)
      throw new Error("Ambiguous Keygen subscription license mapping");
    if (found.length) return id.parse(this.checkLicense(found[0], s.id).id);
    const policy = await this.policy(trial);
    const email = z
      .string()
      .email()
      .parse(s.attributes.user_email)
      .trim()
      .toLowerCase();
    const customerId = z
      .number()
      .int()
      .positive()
      .parse(s.attributes.customer_id);
    const userUrl = this.keygen(`users/${encodeURIComponent(email)}`);
    let user = await this.optional(userUrl, this.keygenToken);
    if (!user) {
      try {
        user = await this.request(
          this.keygen("users"),
          this.keygenToken,
          "POST",
          {
            data: {
              type: "users",
              attributes: {
                email,
                password: null,
                role: "user",
                permissions: [],
                metadata: { deviceDeckCustomer: true },
              },
            },
          },
        );
      } catch (error) {
        // Email is unique in Keygen. Recover a successful-but-unacknowledged creation.
        user = await this.optional(userUrl, this.keygenToken);
        if (!user) throw error;
      }
    }
    if (
      user?.type !== "users" ||
      user.attributes?.email?.toLowerCase() !== email ||
      user.attributes?.role !== "user"
    )
      throw new Error("Keygen customer identity mismatch");
    const key = `DECK-${createHmac("sha256", this.issuanceSecret)
      .update(
        JSON.stringify([
          this.config.keygenAccountId,
          this.config.keygenProductId,
          this.config.testMode,
          s.id,
        ]),
      )
      .digest("hex")
      .toUpperCase()}`;
    const recoveryUrl = this.keygen(`licenses/${encodeURIComponent(key)}`);
    let license = await this.optional(recoveryUrl, this.keygenToken);
    if (!license) {
      try {
        license = await this.request(
          this.keygen("licenses"),
          this.keygenToken,
          "POST",
          {
            data: {
              type: "licenses",
              attributes: {
                name: `Device Deck ${trial ? "Trial" : "Pro"} · subscription ${s.id}`,
                key,
                expiry: new Date(expiry).toISOString(),
                metadata: {
                  lemonSubscriptionId: s.id,
                  lemonCustomerId: customerId,
                  lemonStoreId: this.config.storeId,
                  lemonProductId: this.config.productId,
                  lemonVariantId: this.config.variantId,
                  lemonTestMode: this.config.testMode,
                  deviceDeckMode: this.config.testMode ? "test" : "live",
                },
              },
              relationships: {
                policy: relation("policies", policy),
                user: relation("users", id.parse(user.id)),
              },
            },
          },
        );
      } catch (error) {
        // Key uniqueness gives at-most-one license even after a timeout or process crash.
        license = await this.optional(recoveryUrl, this.keygenToken);
        if (!license) throw error;
      }
    }
    this.checkLicense(license, s.id);
    if (license.relationships?.user?.data?.id !== user.id)
      throw new Error("Keygen license customer mismatch");
    return id.parse(license.id);
  }
  async licenseKey(licenseId: string, subscriptionId: string) {
    const license = this.checkLicense(
      await this.request(
        this.keygen(`licenses/${encodeURIComponent(licenseId)}`),
        this.keygenToken,
      ),
      subscriptionId,
      licenseId,
    );
    if (license.attributes?.suspended)
      throw new Error("License is suspended; contact support");
    return z.string().min(1).parse(license.attributes?.key);
  }
  async createCheckout(claimId: string, returnUrl: string, expires: number) {
    const checkout = await this.request(
      "https://api.lemonsqueezy.com/v1/checkouts",
      this.lemonToken,
      "POST",
      {
        data: {
          type: "checkouts",
          attributes: {
            test_mode: this.config.testMode,
            expires_at: new Date(expires).toISOString(),
            product_options: {
              enabled_variants: [this.config.variantId],
              redirect_url: returnUrl,
              receipt_button_text: "Get your Device Deck license",
              receipt_link_url: returnUrl,
            },
            checkout_data: { custom: { device_deck_claim: claimId } },
          },
          relationships: {
            store: relation("stores", String(this.config.storeId)),
            variant: relation("variants", String(this.config.variantId)),
          },
        },
      },
    );
    if (
      checkout?.type !== "checkouts" ||
      checkout.attributes?.variant_id !== this.config.variantId
    )
      throw new Error("Checkout variant mismatch");
    this.matchesStore(checkout.attributes);
    const url = new URL(z.string().url().parse(checkout.attributes.url));
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".lemonsqueezy.com") ||
      url.username ||
      url.password
    )
      throw new Error("Unexpected checkout destination");
    return url.toString();
  }
  async updateLicense(
    licenseId: string,
    subscriptionId: string,
    expiry: number,
    trial: boolean,
  ) {
    const url = this.keygen(`licenses/${encodeURIComponent(licenseId)}`);
    const license = this.checkLicense(
      await this.request(url, this.keygenToken),
      subscriptionId,
      licenseId,
    );
    const policy = trial
      ? this.config.keygenTrialPolicyId
      : this.config.keygenProPolicyId;
    const currentPolicy = license.relationships?.policy?.data?.id;
    const converting =
      !trial &&
      currentPolicy === this.config.keygenTrialPolicyId &&
      Boolean(this.config.keygenTrialPolicyId);
    if (!policy || (currentPolicy !== policy && !converting))
      throw new Error(
        "Keygen license is not bound to this billing identity and mode",
      );
    if (converting) {
      const target = await this.request(
        this.keygen(`policies/${encodeURIComponent(policy)}`),
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
    // Never clear an operator suspension or change feature entitlements.
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
