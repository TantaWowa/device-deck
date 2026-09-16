import type { User } from "firebase/auth";

export type CloudClient = <T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<T>;

export function createCloudClient(user: Pick<User, "getIdToken">): CloudClient {
  return async <T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) => {
    if (!/^\/(?:machines|pairings)(?:\/[^?#\\]*)?$/.test(path) || path.includes(".."))
      throw new Error("Invalid account API path.");
    const token = await user.getIdToken();
    if (init.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const response = await fetch(`/api/v1${path}`, {
      method: init.method || "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    const text = await response.text();
    let result: any;
    try { result = text ? JSON.parse(text) : undefined; }
    catch { throw new Error("The account service returned an unexpected response. Try again shortly."); }
    if (!response.ok) throw new Error(result?.message || result?.error || `Account service returned ${response.status}.`);
    return result as T;
  };
}
