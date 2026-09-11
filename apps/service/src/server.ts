import http from "node:http";
import {
  serviceContract,
  type Inventory,
} from "../../../packages/core/src/index";
/** Read-only scaffold. No demo devices, hardware access, or session mutations. */
export function createService() {
  const inventory: Inventory = { devices: [], sources: [], leases: [] };
  return http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    const expectedHost = `127.0.0.1:${(res.socket?.address() as { port?: number })?.port}`;
    if (req.headers.host !== expectedHost || req.headers.origin) {
      reply(403, { error: "local-client-required" });
      return;
    }
    if (req.method !== "GET") {
      reply(501, {
        error: "not-implemented",
        message:
          "Session and hardware operations are not implemented in this scaffold.",
      });
      return;
    }
    if (req.url === "/v1/health") {
      reply(200, {
        status: "scaffold",
        hardwareAdapters: 0,
        ...serviceContract,
      });
      return;
    }
    if (req.url === "/v1/inventory") {
      reply(200, inventory);
      return;
    }
    reply(404, { error: "not-found" });
  });
}
