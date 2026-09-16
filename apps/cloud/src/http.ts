import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CloudAuthenticator } from "./auth";
import { CloudError } from "./errors";
import type { CloudService } from "./service";

function json(response: ServerResponse, status: number, value?: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    throw new CloudError(415, "Compressed request bodies are not accepted.");
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new CloudError(415, "Send an application/json request body.");
  if (Number(request.headers["content-length"]) > 16_384) throw new CloudError(413, "Request body is too large.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += chunk.length;
    if (length > 16_384) throw new CloudError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CloudError(400, "Request body must be valid JSON."); }
}

export function cloudServer(options: {
  service: CloudService;
  auth: CloudAuthenticator;
  portalOrigin: string;
  onError?: (error: unknown) => void;
}) {
  const { service, auth, portalOrigin } = options;
  const server = createServer({ maxHeaderSize: 16_384 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Vary", "Origin");
    try {
      const origin = request.headers.origin;
      if (origin && origin !== portalOrigin) throw new CloudError(403, "This browser origin is not allowed.");
      if (origin) response.setHeader("Access-Control-Allow-Origin", portalOrigin);
      const pathname = new URL(request.url || "/", "http://cloud.internal").pathname;
      if (request.method === "GET" && pathname === "/healthz") return json(response, 200, { ok: true });
      if (!pathname.startsWith("/api/v1/")) throw new CloudError(404, "Endpoint not found.");
      const route = pathname.slice("/api/v1".length);
      if (request.method === "OPTIONS") {
        if (!origin) throw new CloudError(403, "Browser origin is required.");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        response.setHeader("Access-Control-Max-Age", "600");
        return json(response, 204);
      }
      if (request.method === "GET" && route === "/public-key") return json(response, 200, service.publicKey());
      const authorizationCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "authorization").length;
      const match = request.headers.authorization?.match(/^Bearer ([^\s,]+)$/);
      if (!match || authorizationCount !== 1) throw new CloudError(401, "Sign in to continue.");
      const { uid } = await auth.authenticate(match[1]);

      if (route === "/machines") {
        if (request.method === "GET") return json(response, 200, await service.listMachines(uid));
        if (request.method === "POST") return json(response, 201, await service.completePairing(uid, await readJson(request)));
        response.setHeader("Allow", "GET, POST");
        throw new CloudError(405, "Method not allowed.");
      }
      if (route === "/pairings") {
        if (request.method === "POST") return json(response, 201, await service.beginPairing(uid, await readJson(request)));
        response.setHeader("Allow", "POST");
        throw new CloudError(405, "Method not allowed.");
      }
      const machineMatch = /^\/machines\/([^/]+)(\/grant)?$/.exec(route);
      if (machineMatch) {
        const machineId = machineMatch[1];
        if (machineMatch[2]) {
          if (request.method === "POST") return json(response, 200, await service.grant(uid, machineId));
          response.setHeader("Allow", "POST");
        } else {
          if (request.method === "GET") return json(response, 200, await service.getMachine(uid, machineId));
          if (request.method === "PATCH") return json(response, 200, await service.updateMachine(uid, machineId, await readJson(request)));
          if (request.method === "DELETE") { await service.deleteMachine(uid, machineId); return json(response, 204); }
          response.setHeader("Allow", "GET, PATCH, DELETE");
        }
        throw new CloudError(405, "Method not allowed.");
      }
      throw new CloudError(404, "Endpoint not found.");
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof CloudError) json(response, error.status, { error: error.message });
      else {
        options.onError?.(error);
        json(response, 500, { error: "The machine registry is temporarily unavailable. Please retry." });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
