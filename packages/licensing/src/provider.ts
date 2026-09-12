import { randomInt } from "node:crypto";
import { z } from "zod";
import { checkLicense, relationship } from "./certificate";
import { FEATURES, OFFLINE_SECONDS, type LicensingTrust } from "./trust";
export type Activation = {
  key: string;
  licenseId: string;
  machineId: string;
  certificate: string;
};
export class ProviderUnavailable extends Error {}
export interface LicenseProvider {
  activate(key: string, fingerprint: string): Promise<Activation>;
  refresh(activation: Activation, fingerprint: string): Promise<Activation>;
  deactivate(activation: Activation): Promise<void>;
}
export class KeygenProvider implements LicenseProvider {
  constructor(
    private trust: LicensingTrust,
    private transport: typeof fetch = fetch,
  ) {}
  private async request(
    key: string,
    route: string,
    method = "GET",
    body?: unknown,
  ): Promise<any> {
    let response: Response;
    try {
      response = await this.transport(
        `https://api.keygen.sh/v1/accounts/${encodeURIComponent(this.trust.accountId)}/${route}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: `License ${key}`,
            Accept: "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      throw new ProviderUnavailable(
        "Keygen could not be reached. Cached access ends at its signed expiry.",
      );
    }
    if (response.status >= 500 || response.status === 429)
      throw new ProviderUnavailable("Keygen is temporarily unavailable.");
    if (!response.ok)
      throw new Error(`Keygen rejected the request (${response.status}).`);
    if (response.status === 204) return;
    const data = await response.json();
    if (data.errors !== undefined)
      throw new Error("Keygen returned an invalid response.");
    return data;
  }
  private async validate(key: string, fingerprint: string, activating = false) {
    const nonce = randomInt(1, 2 ** 48 - 1);
    const scope = {
      product: this.trust.productId,
      fingerprint,
      entitlements: Object.values(FEATURES),
    };
    const result = await this.request(
      key,
      "licenses/actions/validate-key",
      "POST",
      { meta: { key, nonce, scope } },
    );
    const meta = z
      .object({
        valid: z.boolean(),
        code: z.string(),
        nonce: z.number(),
        scope: z.object({
          product: z.string(),
          fingerprint: z.string(),
          entitlements: z.array(z.string()),
        }),
      })
      .parse(result.meta);
    if (
      meta.nonce !== nonce ||
      meta.scope.product !== scope.product ||
      meta.scope.fingerprint !== fingerprint ||
      JSON.stringify([...meta.scope.entitlements].sort()) !==
        JSON.stringify([...scope.entitlements].sort())
    )
      throw new Error("Keygen validation scope or nonce did not match.");
    const checked = checkLicense(
      result.data,
      this.trust,
      key,
      Date.now(),
      activating &&
        meta.valid === false &&
        ["NO_MACHINE", "NO_MACHINES", "FINGERPRINT_SCOPE_MISMATCH"].includes(
          meta.code,
        ),
    );
    const valid = meta.valid === true && meta.code === "VALID";
    if (
      !valid &&
      !(
        activating &&
        meta.valid === false &&
        ["NO_MACHINE", "NO_MACHINES", "FINGERPRINT_SCOPE_MISMATCH"].includes(
          meta.code,
        )
      )
    )
      throw new Error(`License validation failed (${meta.code}).`);
    return { licenseId: checked.license.id, valid };
  }
  private async checkout(key: string, licenseId: string, machineId: string) {
    const query = new URLSearchParams({
      ttl: String(OFFLINE_SECONDS),
      include: "license,license.entitlements",
      algorithm: "aes-256-gcm+ed25519",
    });
    const result = await this.request(
      key,
      `machines/${encodeURIComponent(machineId)}/actions/check-out?${query}`,
      "POST",
    );
    const certificate = z
      .string()
      .min(1)
      .max(1024 * 1024)
      .parse(result.data?.attributes?.certificate);
    return { key, licenseId, machineId, certificate };
  }
  async activate(key: string, fingerprint: string) {
    const initial = await this.validate(key, fingerprint, true);
    let machineId: string;
    if (initial.valid) {
      const result = await this.request(
        key,
        `machines/${encodeURIComponent(fingerprint)}`,
      );
      machineId = z.string().parse(result.data?.id);
      if (
        result.data?.attributes?.fingerprint !== fingerprint ||
        relationship(result.data, "license", "licenses") !== initial.licenseId
      )
        throw new Error("Keygen returned another machine.");
    } else {
      const result = await this.request(key, "machines", "POST", {
        data: {
          type: "machines",
          attributes: {
            fingerprint,
            name: "Device Deck Mac",
            platform: process.platform,
          },
          relationships: {
            license: { data: { type: "licenses", id: initial.licenseId } },
          },
        },
      });
      machineId = z.string().parse(result.data?.id);
      if (
        result.data?.attributes?.fingerprint !== fingerprint ||
        relationship(result.data, "license", "licenses") !== initial.licenseId
      )
        throw new Error("Activation identity mismatch.");
    }
    const valid = await this.validate(key, fingerprint);
    if (valid.licenseId !== initial.licenseId)
      throw new Error("License changed during activation.");
    return this.checkout(key, valid.licenseId, machineId);
  }
  async refresh(activation: Activation, fingerprint: string) {
    const valid = await this.validate(activation.key, fingerprint);
    if (valid.licenseId !== activation.licenseId)
      throw new Error("License identity changed.");
    return this.checkout(
      activation.key,
      activation.licenseId,
      activation.machineId,
    );
  }
  async deactivate(activation: Activation) {
    await this.request(
      activation.key,
      `machines/${encodeURIComponent(activation.machineId)}`,
      "DELETE",
    );
  }
}
