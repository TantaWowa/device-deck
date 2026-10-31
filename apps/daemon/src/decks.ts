import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, SerialQueue } from "../../../packages/config/src";
import { deckConnectionSchema, deckNameSchema, deckSummarySchema } from "../../../packages/core/src/decks";
import { DeckError, operations } from "../../../packages/core/src/local/types";
import { machineIdentitySchema } from "../../../packages/core/src/hub";

const grantSchema = z.object({ id: z.string().uuid(), name: deckNameSchema, hash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number() }).strict();
const stateSchema = z.object({
  decks: z.array(deckSummarySchema.extend({ token: deckConnectionSchema.shape.token })),
  grants: z.array(grantSchema),
}).strict();
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export function assertSharedRoute(method: string, pathname: string) {
  if (method === "POST" && pathname.startsWith("/v1/operations/")) {
    const operation = pathname.slice("/v1/operations/".length);
    if (Object.hasOwn(operations, operation) && !["license.activate", "license.refresh", "license.deactivate"].includes(operation)) return;
  }
  if (method === "GET" && (
    ["/v1/health", "/v1/hub/status", "/v1/machine"].includes(pathname) ||
    /^\/v1\/(?:preview|source-preview|capture-card-thumbnail)\/[^/]+$/.test(pathname) ||
    /^\/v1\/artifacts\/[^/]+\/(?:file|clean|log|thumbnail)$/.test(pathname)
  )) return;
  throw new DeckError("deck-operation-denied", "This route is not shared with another Deck. Manage connections and licensing on the host Mac.", 403);
}

export class DeckConnections {
  private queue = new SerialQueue();
  private readonly file: string;
  constructor(directory: string) { this.file = path.join(directory, "deck-connections.json"); }

  private async read() {
    try { return stateSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { decks: [], grants: [] };
      throw new DeckError("deck-config-invalid", "Deck connections could not be read. Repair the private deck-connections.json file on this Mac.", 503);
    }
  }

  async list() {
    const state = await this.read();
    return { decks: state.decks.map(({ token: _token, ...deck }) => deck) };
  }

  async grants() {
    return { grants: (await this.read()).grants.map(({ hash: _hash, ...grant }) => grant) };
  }

  async authorize(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const hash = Buffer.from(digest(token), "hex");
    return (await this.read()).grants.some((grant) => timingSafeEqual(hash, Buffer.from(grant.hash, "hex")));
  }

  grant(name: string) {
    return this.queue.run(async () => {
      deckNameSchema.parse(name);
      const state = await this.read();
      const token = randomBytes(32).toString("base64url");
      const grant = { id: randomUUID(), name, hash: digest(token), createdAt: Date.now() };
      state.grants.push(grant);
      await atomicWrite(this.file, JSON.stringify(state));
      return { id: grant.id, name, token };
    });
  }

  revoke(id: string) {
    return this.queue.run(async () => {
      z.string().uuid().parse(id);
      const state = await this.read();
      state.grants = state.grants.filter((grant) => grant.id !== id);
      await atomicWrite(this.file, JSON.stringify(state));
      return { ok: true };
    });
  }

  async add(value: unknown, localMachineId: string) {
    const connection = deckConnectionSchema.parse(value);
    const response = await this.request(connection, "/v1/health", { method: "GET" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DeckError("deck-authentication-failed", `Deck ${connection.name} refused the connection (${response.status}). Check its address and access token.`, 502);
    }
    await response.body?.cancel();
    const identityResponse = await this.request(connection, "/v1/machine", { method: "GET" });
    const identity = machineIdentitySchema.parse(await identityResponse.json());
    if (identity.id === localMachineId) throw new DeckError("deck-self-connection", "Choose a different Mac. This address belongs to the local Deck.", 400);
    return this.queue.run(async () => {
      const state = await this.read();
      if (state.decks.some((deck) => deck.name === connection.name || deck.machineId === identity.id))
        throw new DeckError("deck-already-connected", "This name or machine is already connected. Remove the old connection before adding it again.", 409);
      const deck = { ...connection, machineId: identity.id };
      state.decks.push(deck);
      await atomicWrite(this.file, JSON.stringify(state));
      const { token: _token, ...summary } = deck;
      return summary;
    });
  }

  remove(name: string) {
    return this.queue.run(async () => {
      deckNameSchema.parse(name);
      const state = await this.read();
      state.decks = state.decks.filter((deck) => deck.name !== name);
      await atomicWrite(this.file, JSON.stringify(state));
      return { ok: true };
    });
  }

  async forward(name: string, route: string, init: RequestInit) {
    deckNameSchema.parse(name);
    const target = new URL(route, "http://deck.invalid");
    if (target.origin !== "http://deck.invalid" || target.pathname + target.search !== route)
      throw new DeckError("deck-operation-denied", "Invalid remote Deck route.", 400);
    assertSharedRoute(init.method || "GET", target.pathname);
    const deck = (await this.read()).decks.find((item) => item.name === name);
    if (!deck) throw new DeckError("deck-not-found", `Deck ${name} is not connected. Run devdeck decks list.`, 404);
    return this.request(deck, route, init);
  }

  private async request(deck: z.infer<typeof deckConnectionSchema>, route: string, init: RequestInit) {
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${deck.token}`);
      headers.set("X-Device-Deck", "local");
      return await fetch(`${deck.address}${route}`, {
        ...init, headers, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(route.includes("reserveGroup") ? 610000 : 180000), ...(init.signal ? [init.signal] : [])]),
      });
    } catch {
      throw new DeckError("deck-unavailable", `Deck ${deck.name} is unreachable. No local operation was attempted. If a mutation was sent, inspect the host before retrying.`, 502);
    }
  }
}
