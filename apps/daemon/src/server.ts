import { version } from "../../../packages/core/src/version";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { DeckService } from "./local/service";
import { allowedNetworkHosts, isLoopback, MachineAuthority } from "./network";
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
  options: {
    tls?: https.ServerOptions;
    bindHost?: string;
    networkPort?: number;
    authority?: MachineAuthority;
    credentials?: ReturnType<typeof createBrowserCredentials>;
  } = {},
) {
  const { tickets, browsers } = options.credentials || createBrowserCredentials();
  const authority = options.authority || new MachineAuthority(deck.directory);
  const handler: http.RequestListener = async (req, res) => {
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
    const port = (server.address() as { port: number }).port;
    const host = `127.0.0.1:${port}`;
    const local = req.headers.host === host || req.headers.host === new URL(`${options.tls ? "https" : "http"}://${host}`).host;
    const tailscale = deck.config.config.tailscale;
    const remote = !local && tailscale &&
      req.headers.host === new URL(tailscale.origin).host;
    const network = deck.config.config.network;
    const acceptedHost = req.headers.host && allowedNetworkHosts(network, port, options.bindHost, options.tls ? "https:" : "http:").has(req.headers.host);
    const origin = remote ? tailscale.origin : acceptedHost ? new URL(`${options.tls ? "https" : "http"}://${req.headers.host}`).origin : undefined;
    const allowedOrigins = new Set([origin, ...(network?.allowedOrigins || []), network?.hubOrigin]);
    if (
      !origin ||
      (req.headers.origin && !allowedOrigins.has(req.headers.origin))
    ) {
      reply(403, {
        error: "local-client-required",
        message: "Use an allowed Device Deck address and browser origin. Configure network access with devdeck network enable.",
      });
      return;
    }
    // Serve strips client-supplied identity headers and supplies its verified
    // user. Trust only requests whose immediate peer is loopback. Never accept
    // this identity on the local origin or use cookies/tokens to bypass it.
    const login = req.headers["tailscale-user-login"];
    const loopback = isLoopback(req.socket.remoteAddress);
    if (remote && (
      !loopback ||
      req.headers["x-forwarded-proto"] !== "https" ||
      req.headers["tailscale-funnel-request"] !== undefined ||
      typeof login !== "string" ||
      !tailscale.allowedUsers.includes(login)
    )) {
      reply(403, {
        error: "tailscale-access-denied",
        message: "Connect through Tailscale Serve using an allowed Tailscale account.",
      });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || "/", origin);
    } catch {
      reply(400, { error: "invalid-url", message: "Invalid request URL." });
      return;
    }
    if (req.headers.origin && allowedOrigins.has(req.headers.origin)) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges");
    }
    if (req.method === "OPTIONS") {
      const requested = (req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
      if (!req.headers.origin || !["GET", "POST"].includes(String(req.headers["access-control-request-method"])) || requested.some((header) => !["authorization", "x-device-deck", "content-type", "range"].includes(header))) {
        reply(403, { error: "cors", message: "Browser request is not allowed." });
        return;
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, X-Device-Deck, Content-Type, Range");
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204);
      res.end();
      return;
    }
    const apiToken = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const cookieName = `deck_${(server.address() as { port: number }).port}`;
    const cookie =
      new RegExp(`(?:^|;\\s*)${cookieName}=([A-Za-z0-9_-]+)`).exec(
        req.headers.cookie || "",
      )?.[1] || "";
    const native = !remote && equal(apiToken, token);
    const localNative = native && local && loopback;
    const session = browsers.get(cookie);
    const browser = Boolean(remote) || Boolean(session && session.host === req.headers.host && session.expiresAt > Date.now());
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
      if (url.pathname === "/v1/machine" && req.method === "GET") {
        reply(200, await authority.metadata());
        return;
      }
      if (url.pathname === "/v1/hub/pairing-code" && req.method === "POST") {
        if (!localNative) throw new DeckError("local-client-required", "Run devdeck pair locally on this machine.", 403);
        await json();
        reply(200, await authority.issueCode(network?.hubOrigin));
        return;
      }
      if (url.pathname === "/v1/hub/unpair" && req.method === "POST") {
        if (!localNative) throw new DeckError("local-client-required", "Run devdeck pair --revoke locally on this machine.", 403);
        await json();
        reply(200, await authority.unpair());
        return;
      }
      if (url.pathname === "/v1/hub/pair" && req.method === "POST") {
        reply(200, await authority.pair(await json()));
        return;
      }
      if (url.pathname === "/v1/bootstrap" && req.method === "POST") {
        if (remote)
          throw new DeckError("local-client-required", "Tailscale access uses your Tailscale account, not a local launch ticket.", 403);
        const { ticket } = await json();
        const launch = tickets.get(ticket);
        tickets.delete(ticket);
        if (!launch || launch.expiresAt <= Date.now() || launch.host !== req.headers.host)
          throw new DeckError(
            "invalid-ticket",
            "Open this dashboard with devdeck ui.",
            403,
          );
        const credential = randomBytes(32).toString("base64url");
        for (const [key, session] of browsers) if (session.expiresAt <= Date.now()) browsers.delete(key);
        if (browsers.size >= 1000) throw new DeckError("too-many-browsers", "Too many active dashboard sessions. Restart Device Deck to clear them.", 429);
        browsers.set(credential, { expiresAt: Date.now() + 24 * 60 * 60000, host: req.headers.host! });
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.tls ? "; Secure" : ""}`,
        );
        reply(200, { ok: true });
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        const hub = !native && !browser && Boolean(apiToken) && await authority.authorize(apiToken);
        if (!native && !browser && !hub)
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
            version,
            mode: "local",
            pid: process.pid,
            operations: Object.keys(operations),
            diagnostics: deck.diagnostics,
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/browser-ticket") {
          if (!localNative)
            throw new DeckError(
              "unauthorized",
              "A local command must open the dashboard.",
              403,
            );
          const request = await json();
          let ticketHost = req.headers.host!;
          if (request.address !== undefined) {
            const address = new URL(request.address);
            if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.origin !== request.address ||
              !allowedNetworkHosts(network, options.networkPort ?? port, options.bindHost, address.protocol).has(address.host))
              throw new DeckError("invalid-address", "Use a configured machine origin without a path. Add custom hostnames using --allow-host.", 400);
            ticketHost = address.host;
          }
          for (const [key, launch] of tickets)
            if (launch.expiresAt <= Date.now()) tickets.delete(key);
          if (tickets.size >= 100) throw new DeckError("too-many-tickets", "Too many unused launch tickets. Wait one minute before retrying.", 429);
          const ticket = randomBytes(32).toString("base64url");
          tickets.set(ticket, { expiresAt: Date.now() + 60000, host: ticketHost });
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
          const origin: Artifact["origin"] = browser || hub
            ? "Web"
            : claimed === "Agent"
              ? "Agent"
              : claimed === "CLI"
                ? "CLI"
                : "API";
          const value = await json();
          if (operation === "config.save" && !localNative &&
            (JSON.stringify(value.config?.network) !== JSON.stringify(deck.config.config.network) ||
              JSON.stringify(value.config?.tailscale) !== JSON.stringify(deck.config.config.tailscale)))
            throw new DeckError("local-client-required", "Change network and portal trust settings with the local Device Deck CLI.", 403);
          // A caller can delay uploading its body. Check the same hub credential
          // again after that wait so expiry or local revocation prevents dispatch.
          if (hub && !await authority.authorize(apiToken))
            throw new DeckError("unauthorized", "Machine access expired or was revoked before the request completed. Reconnect from your machines page.", 401);
          reply(
            200,
            await deck.execute(operation as Operation, value, origin),
          );
          return;
        }
        if (
          req.method === "GET" &&
          url.pathname.startsWith("/v1/source-preview/")
        ) {
          const data = await deck.previewSource(
            decodeURIComponent(
              url.pathname.slice("/v1/source-preview/".length),
            ),
          );
          res.writeHead(200, {
            "Content-Type": data[0] === 137 ? "image/png" : "image/jpeg",
          });
          res.end(data);
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
  };
  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  server.requestTimeout = 190000;
  return server;
}

export function createBrowserCredentials() {
  return { tickets: new Map<string, { expiresAt: number; host: string }>(), browsers: new Map<string, { expiresAt: number; host: string }>() };
}
