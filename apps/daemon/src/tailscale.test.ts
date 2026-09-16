import assert from "node:assert/strict";
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Artifact, Operation } from "../../../packages/core/src/local/types";
import { DeckService } from "./local/service";
import { createService } from "./server";

const publicOrigin = "https://deck.example-tailnet.ts.net:8443";
const owner = "owner@example.com";
const token = "tailscale-http-test-local-token";

// Exercise the real HTTP boundary without starting discovery or capture tools.
class HttpDeck extends DeckService {
  calls: { operation: Operation; value: unknown; origin: Artifact["origin"] }[] = [];
  previews: string[] = [];

  override async execute(
    operation: Operation,
    value: unknown,
    origin: Artifact["origin"] = "API",
  ) {
    this.calls.push({ operation, value, origin });
    return { ok: true };
  }

  override async previewSource(sourceId: string) {
    this.previews.push(sourceId);
    return Buffer.from([255, 216, 255, 217]);
  }
}

type Response = { status: number; headers: IncomingHttpHeaders; body: Buffer };

async function fixture(t: TestContext, enabled = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-tailscale-http-"));
  const deck = new HttpDeck(directory);
  if (enabled)
    deck.config.config.tailscale = { origin: publicOrigin, allowedUsers: [owner] };
  await writeFile(path.join(directory, "index.html"), "<h1>Device Deck</h1>");
  const server = createService(deck, token, directory);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const request = (
    route: string,
    headers: OutgoingHttpHeaders = {},
    method = "GET",
    body?: unknown,
  ) => new Promise<Response>((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: route, method,
      headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const remote: OutgoingHttpHeaders = {
    Host: new URL(publicOrigin).host,
    "X-Forwarded-Host": new URL(publicOrigin).host,
    "X-Forwarded-Proto": "https",
    "Tailscale-User-Login": owner,
  };
  const mutation: OutgoingHttpHeaders = {
    ...remote,
    Origin: publicOrigin,
    "Content-Type": "application/json",
    "X-Device-Deck": "local",
  };
  return { deck, request, remote, mutation, port };
}

function denied(response: Response, message?: string) {
  assert.ok([401, 403].includes(response.status), `${message || "request"}: ${response.status}`);
}

test("Tailscale owner opens the UI and uses API and previews without a launch ticket", async (t) => {
  const { deck, request, remote, mutation } = await fixture(t);
  const page = await request("/", remote);
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Device Deck/);
  assert.equal(page.headers["set-cookie"], undefined);
  assert.equal((await request("/v1/health", remote)).status, 200);
  assert.equal((await request("/v1/operations/config.get", {
    ...mutation, "X-Device-Deck-Client": "Agent",
  }, "POST", {})).status, 200);
  assert.deepEqual(deck.calls, [{ operation: "config.get", value: {}, origin: "Web" }]);
  const preview = await request("/v1/source-preview/usb-camera", remote);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["content-type"], "image/jpeg");
  assert.deepEqual(preview.body, Buffer.from([255, 216, 255, 217]));
  assert.deepEqual(deck.previews, ["usb-camera"]);
});

test("Tailscale access is opt-in and local headers cannot enable it", async (t) => {
  const { request, remote } = await fixture(t, false);
  denied(await request("/", remote));
  denied(await request("/v1/health", { ...remote, Authorization: `Bearer ${token}` }));
  denied(await request("/v1/health", { "Tailscale-User-Login": owner }));
  assert.equal((await request("/v1/health", { Authorization: `Bearer ${token}` })).status, 200);
});

test("Tailscale requires the exact configured host, HTTPS proxy, and allowed identity on every route", async (t) => {
  const { deck, request, remote } = await fixture(t);
  const invalid: { name: string; headers: OutgoingHttpHeaders }[] = [
    { name: "missing user", headers: { ...remote, "Tailscale-User-Login": undefined } },
    { name: "another tailnet user", headers: { ...remote, "Tailscale-User-Login": "someone@example.com" } },
    { name: "identity suffix", headers: { ...remote, "Tailscale-User-Login": `${owner}.evil` } },
    { name: "multiple identities", headers: { ...remote, "Tailscale-User-Login": [owner, "someone@example.com"] } },
    { name: "missing forwarded protocol", headers: { ...remote, "X-Forwarded-Proto": undefined } },
    { name: "HTTP forwarded protocol", headers: { ...remote, "X-Forwarded-Proto": "http" } },
    { name: "protocol list", headers: { ...remote, "X-Forwarded-Proto": "https,http" } },
    { name: "another host", headers: { ...remote, Host: "other.example-tailnet.ts.net:8443" } },
    { name: "missing configured port", headers: { ...remote, Host: new URL(publicOrigin).hostname } },
    { name: "wrong Origin", headers: { ...remote, Origin: "https://evil.example" } },
    { name: "null Origin", headers: { ...remote, Origin: "null" } },
    { name: "Funnel", headers: { ...remote, "Tailscale-Funnel-Request": "?1" } },
  ];
  for (const { name, headers } of invalid) {
    denied(await request("/", headers), `${name}: UI`);
    denied(await request("/v1/health", headers), `${name}: API`);
    denied(await request("/v1/source-preview/usb-camera", headers), `${name}: preview`);
  }
  assert.deepEqual(deck.previews, []);
  assert.deepEqual(deck.calls, []);
});

test("Tailscale browser mutations retain Origin, custom-header, and JSON restrictions", async (t) => {
  const { deck, request, mutation } = await fixture(t);
  denied(await request("/v1/operations/config.get", {
    ...mutation, "X-Device-Deck": undefined,
  }, "POST", {}));
  denied(await request("/v1/operations/config.get", {
    ...mutation, Origin: "http://deck.example-tailnet.ts.net:8443",
  }, "POST", {}));
  denied(await request("/v1/operations/config.get", {
    ...mutation, Origin: "https://other.example-tailnet.ts.net:8443",
  }, "POST", {}));
  assert.equal((await request("/v1/operations/config.get", {
    ...mutation, "Content-Type": "text/plain",
  }, "POST", {})).status, 415);
  assert.deepEqual(deck.calls, []);
});

test("local browser credentials neither bypass Tailscale identity nor become remote credentials", async (t) => {
  const { request, remote, mutation, port } = await fixture(t);
  const native = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const issued = await request("/v1/browser-ticket", native, "POST", {});
  assert.equal(issued.status, 200);
  const ticket = JSON.parse(issued.body.toString()).ticket;
  denied(await request("/v1/bootstrap", mutation, "POST", { ticket }));
  denied(await request("/v1/browser-ticket", {
    ...mutation, Authorization: `Bearer ${token}`,
  }, "POST", {}));
  const bootstrapped = await request("/v1/bootstrap", {
    "Content-Type": "application/json",
  }, "POST", { ticket });
  assert.equal(bootstrapped.status, 200, "remote bootstrap must not consume the local ticket");
  const cookie = bootstrapped.headers["set-cookie"]?.[0].split(";")[0];
  assert.ok(cookie);
  assert.equal((await request("/v1/health", { Cookie: cookie })).status, 200);
  for (const credentials of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
    denied(await request("/v1/health", {
      ...remote, ...credentials, "Tailscale-User-Login": undefined,
    }));
    denied(await request("/v1/health", {
      ...remote, ...credentials, "Tailscale-User-Login": "someone@example.com",
    }));
  }
  denied(await request("/v1/health", {
    Authorization: `Bearer ${token}`, Origin: publicOrigin,
  }));
  denied(await request("/v1/health", {
    ...remote, Host: `127.0.0.1:${port}`,
  }));
  denied(await request("/v1/health", {
    ...remote, Host: `127.0.0.1:${port}`, Origin: publicOrigin,
  }));
});

test("changing or disabling the Tailscale allowlist revokes subsequent requests immediately", async (t) => {
  const { deck, request, remote } = await fixture(t);
  assert.equal((await request("/v1/health", remote)).status, 200);
  deck.config.config.tailscale = { origin: publicOrigin, allowedUsers: ["replacement@example.com"] };
  denied(await request("/v1/health", remote));
  const replacement = { ...remote, "Tailscale-User-Login": "replacement@example.com" };
  assert.equal((await request("/v1/health", replacement)).status, 200);
  delete deck.config.config.tailscale;
  denied(await request("/v1/health", replacement));
  assert.equal((await request("/v1/health", { Authorization: `Bearer ${token}` })).status, 200);
});
