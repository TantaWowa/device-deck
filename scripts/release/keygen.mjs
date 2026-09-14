/** Operator-only Keygen client. Never bundled into the desktop application. */
export class Keygen {
  constructor({
    accountId = process.env.KEYGEN_ACCOUNT_ID,
    token = process.env.KEYGEN_TOKEN || process.env.KEYGEN_ADMIN_TOKEN,
    transport = fetch,
  } = {}) {
    if (!accountId || !token)
      throw new Error(
        "KEYGEN_ACCOUNT_ID and KEYGEN_TOKEN (or KEYGEN_ADMIN_TOKEN) are required in the operator environment.",
      );
    this.accountId = accountId;
    this.token = token;
    this.transport = transport;
  }
  async request(route, { method = "GET", body, headers = {} } = {}) {
    const url = new URL(
      `https://api.keygen.sh/v1/accounts/${encodeURIComponent(this.accountId)}${route}`,
    );
    const response = await this.transport(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        ...headers,
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return {};
    const result = await response.json();
    if (!response.ok || result.errors) {
      // Do not echo request data or provider error details containing license keys.
      throw new Error(
        `Keygen ${method} ${url.pathname}: HTTP ${response.status}; ${(result.errors || []).map((e) => `${e.code || e.title || "error"} ${e.source?.pointer || ""}`).join("; ")}`,
      );
    }
    return result;
  }
  async list(route) {
    const all = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({
        "page[number]": String(page),
        "page[size]": "100",
      });
      const result = await this.request(
        `${route}${route.includes("?") ? "&" : "?"}${query}`,
      );
      if (!Array.isArray(result.data))
        throw new Error("Keygen returned an invalid collection.");
      all.push(...result.data);
      if (result.data.length < 100) return all;
    }
  }
  async create(type, attributes, relationships) {
    return (
      await this.request(`/${type}`, {
        method: "POST",
        body: {
          data: {
            type,
            attributes,
            ...(relationships ? { relationships } : {}),
          },
        },
      })
    ).data;
  }
}
export const relation = (type, id) => ({ data: { type, id } });
