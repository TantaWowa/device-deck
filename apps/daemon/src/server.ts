import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { DeckService } from "./local/service";
import {
  DeckError,
  operations,
  type Operation,
  type Artifact,
} from "../../../packages/core/src/local/types";
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function createService(
  deck: DeckService,
  token: string,
  webRoot: string,
) {
  const tickets = new Map<string, number>(),
    browsers = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)
    ) {
      reply(403, {
        error: "local-client-required",
        message: "Use the local Device Deck client.",
      });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || "/", `http://${host}`);
    } catch {
      reply(400, { error: "invalid-url", message: "Invalid request URL." });
      return;
    }
    const apiToken = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const cookie =
      /(?:^|;\s*)deck=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || "")?.[1] ||
      "";
    const native = equal(apiToken, token),
      browser = (browsers.get(cookie) || 0) > Date.now();
    const json = async () => {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new DeckError("content-type", "Use application/json.", 415);
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024)
          throw new DeckError("too-large", "Request exceeds 1 MB.", 413);
        chunks.push(chunk);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        throw new DeckError("invalid-json", "Invalid JSON.", 400);
      }
    };
    try {
      if (url.pathname === "/v1/bootstrap" && req.method === "POST") {
        const { ticket } = await json();
        const until = tickets.get(ticket) || 0;
        tickets.delete(ticket);
        if (until < Date.now())
          throw new DeckError(
            "invalid-ticket",
            "Open this dashboard with devdeck ui.",
            403,
          );
        const credential = randomBytes(32).toString("base64url");
        browsers.set(credential, Date.now() + 24 * 60 * 60000);
        res.setHeader(
          "Set-Cookie",
          `deck=${credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        );
        reply(200, { ok: true });
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        if (!native && !browser)
          throw new DeckError(
            "unauthorized",
            "Open the dashboard with devdeck ui, or supply the local API token.",
            401,
          );
        if (
          !native &&
          req.method !== "GET" &&
          req.headers["x-device-deck"] !== "local"
        )
          throw new DeckError("csrf", "Missing local client header.", 403);
        if (req.method === "GET" && url.pathname === "/v1/health") {
          reply(200, {
            status: "ready",
            version: "0.3.0",
            mode: "local",
            pid: process.pid,
            operations: Object.keys(operations),
            diagnostics: deck.diagnostics,
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/browser-ticket") {
          if (!native)
            throw new DeckError(
              "unauthorized",
              "A local command must open the dashboard.",
              403,
            );
          await json();
          for (const [key, until] of tickets)
            if (until < Date.now()) tickets.delete(key);
          const ticket = randomBytes(32).toString("base64url");
          tickets.set(ticket, Date.now() + 60000);
          reply(200, { ticket });
          return;
        }
        if (
          req.method === "POST" &&
          url.pathname.startsWith("/v1/operations/")
        ) {
          const operation = url.pathname.slice("/v1/operations/".length);
          if (!Object.hasOwn(operations, operation))
            throw new DeckError("not-found", "Unknown operation.", 404);
          const claimed = req.headers["x-device-deck-client"];
          const origin: Artifact["origin"] = browser
            ? "Web"
            : claimed === "Agent"
              ? "Agent"
              : claimed === "CLI"
                ? "CLI"
                : "API";
          reply(
            200,
            await deck.execute(operation as Operation, await json(), origin),
          );
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/v1/preview/")) {
          const data = await deck.preview(
            decodeURIComponent(url.pathname.slice("/v1/preview/".length)),
          );
          res.writeHead(200, {
            "Content-Type": data[0] === 137 ? "image/png" : "image/jpeg",
          });
          res.end(data);
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/v1/artifacts/")) {
          const [, , , id, variant = "file"] = url.pathname.split("/");
          const a = deck.store.artifact(id);
          if (a.deletedAt)
            throw new DeckError(
              "artifact-removed",
              "Capture is in the trash. Restore it first.",
              410,
            );
          const file =
            variant === "log"
              ? a.logPath
              : variant === "clean"
                ? a.cleanPath || a.path
                : a.path;
          const info = await stat(file);
          const range =
            req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          const begin = range ? Number(range[1]) : 0,
            end = range?.[2] ? Number(range[2]) : info.size - 1;
          if (begin < 0 || end >= info.size || begin > end) {
            res.setHeader("Content-Range", `bytes */${info.size}`);
            reply(416, { error: "invalid-range" });
            return;
          }
          res.setHeader(
            "Content-Type",
            variant === "log"
              ? "application/json"
              : a.kind === "recording"
                ? "video/mp4"
                : "image/png",
          );
          const fileName =
            a.name.replace(/[\x00-\x1f\x7f/\\]/g, "-") +
            (variant === "clean" ? "-clean" : "") +
            (variant === "log"
              ? ".json"
              : a.kind === "recording"
                ? ".mp4"
                : ".png");
          res.setHeader(
            "Content-Disposition",
            `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          );
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Length", end - begin + 1);
          if (range)
            res.setHeader(
              "Content-Range",
              `bytes ${begin}-${end}/${info.size}`,
            );
          res.writeHead(range ? 206 : 200);
          const stream = createReadStream(file, { start: begin, end });
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
          return;
        }
        throw new DeckError("not-found", "Route not found.", 404);
      }
      if (req.method !== "GET")
        throw new DeckError("not-found", "Route not found.", 404);
      const relative =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(webRoot, relative);
      if (!file.startsWith(path.resolve(webRoot) + path.sep))
        throw new DeckError("not-found", "File not found.", 404);
      const data = await readFile(file);
      const ext = path.extname(file);
      res.writeHead(200, {
        "Content-Type":
          (
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".png": "image/png",
            } as Record<string, string>
          )[ext] || "application/octet-stream",
      });
      res.end(data);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof ZodError)
        reply(400, {
          error: "validation",
          message: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
      else if (e instanceof DeckError)
        reply(e.status, {
          error: e.code,
          message: e.message,
          details: e.details,
        });
      else if ((e as NodeJS.ErrnoException).code === "ENOENT")
        reply(404, {
          error: "file-missing",
          message:
            "File is missing. Build the local app or check the capture folder.",
        });
      else {
        console.error((e as Error).message);
        reply(500, { error: "service-error", message: (e as Error).message });
      }
    }
  });
  server.requestTimeout = 190000;
  return server;
}
