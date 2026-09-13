import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BillingBridge } from "./bridge";
const script = `const message = document.querySelector('#message');
const buy = document.querySelector('#buy');
if (buy) buy.addEventListener('click', async () => {
  buy.disabled = true; message.textContent = 'Opening secure checkout…';
  try { const response = await fetch('/checkout', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    if (!response.ok) throw Error(); const data = await response.json(); location.assign(data.url);
  } catch { message.textContent = 'Checkout is unavailable. Please try again shortly.'; buy.disabled = false; }
});
if (document.querySelector('#license')) {
  const token = new URLSearchParams(location.hash.slice(1)).get('claim');
  if (token) history.replaceState(null, '', '/activate');
  let attempts = 0;
  async function poll() {
    try { const response = await fetch('/license', {method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:'{}'});
      if (!response.ok) {message.textContent = response.status===401 ? 'This retrieval link has expired or belongs to a different browser. Contact support for a new link.' : 'License retrieval is unavailable. Please retry shortly.'; return;}
      const data = await response.json();
      if (data.state==='ready') { document.querySelector('#license').value=data.key; document.querySelector('#ready').hidden=false; message.textContent='Your license is ready. Keep it private.'; return; }
      if (data.state==='held') {message.textContent='This purchase needs a support review. Please contact support.';return;}
      if (++attempts > 120) {message.textContent='Payment is still processing. Refresh this page shortly. Your purchase will not be lost.';return;}
      message.textContent='Waiting for payment confirmation…';setTimeout(poll,5000);
    } catch {message.textContent='Connection interrupted. Refresh this page to retry.';}
  }
  document.querySelector('#copy').addEventListener('click', async()=>{try{await navigator.clipboard.writeText(document.querySelector('#license').value);message.textContent='License copied.';}catch{document.querySelector('#license').select();}});
  poll();
}`;
function page(activate: boolean, testMode: boolean) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Device Deck · ${activate ? "Your license" : "Pro"}</title><link rel="stylesheet" href="/assets/onboarding.css"><main><p class="brand">DEVICE DECK${testMode ? " · TEST CHECKOUT" : ""}</p><h1>${activate ? "Your workspace, unlocked." : "Get Device Deck Pro."}</h1>${activate ? '<p>Copy your key into Device Deck → License → Activate, or save it in a private file and run <code>devdeck license activate /path/to/license-key.txt</code>.</p><div id="ready" hidden><label for="license">License key</label><textarea id="license" rows="3" readonly spellcheck="false"></textarea><button id="copy">Copy license key</button></div>' : '<p>Complete your purchase securely with Lemon Squeezy. Return to this browser after checkout to collect your license.</p><button id="buy">Continue to checkout</button>'}<p id="message" role="status"></p><p class="muted">${activate ? "If you used another browser or your link has expired, contact the support address on your purchase receipt for a new retrieval link." : "Pricing, taxes and subscription terms are shown before you pay."}</p></main><script src="/assets/onboarding.js" defer></script></html>`;
}
const css = `:root{color-scheme:dark;font:17px/1.55 system-ui;background:#0e1524;color:#e9f1fb}body{margin:0;padding:32px}main{max-width:560px;margin:10vh auto}.brand{font-weight:800;font-size:13px;letter-spacing:2px;color:#74e8cb}h1{font-size:38px;line-height:1.1}p{color:#b3c0d7}button{padding:12px 20px;border:0;border-radius:9px;font:inherit;font-weight:700;background:#74e8cb;color:#122632;cursor:pointer}button:disabled{opacity:.6}textarea{box-sizing:border-box;width:100%;margin:8px 0 16px;padding:14px;color:inherit;background:#172238;border:1px solid #475977;border-radius:8px;font:14px monospace;resize:vertical}.muted{font-size:13px}code{color:#d6e5ff}button:focus-visible,textarea:focus-visible{outline:3px solid #f9c95c;outline-offset:3px}`;
function json(res: ServerResponse, status: number, value: unknown) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(value));
}
async function body(req: IncomingMessage, max = 256 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function billingServer(options: {
  bridge: BillingBridge;
  publicUrl: string;
  adminSecret: string;
  wake: () => void;
  ready: () => boolean;
}) {
  const { bridge, adminSecret } = options,
    origin = new URL(options.publicUrl).origin;
  if (adminSecret.length < 32)
    throw new Error("Use an admin secret of at least 32 characters");
  const secure = origin.startsWith("https://");
  if (
    !secure &&
    !(
      bridge.config.testMode &&
      ["127.0.0.1", "localhost"].includes(new URL(origin).hostname)
    )
  )
    throw new Error(
      "Billing public URL must use HTTPS (loopback HTTP is allowed in test mode only)",
    );
  const limits = new Map<string, { count: number; until: number }>();
  function limited(
    req: IncomingMessage,
    kind: string,
    maximum: number,
    duration: number,
  ) {
    const now = Date.now();
    for (const [key, value] of limits)
      if (value.until <= now) limits.delete(key);
    const key = `${req.socket.remoteAddress}:${kind}`;
    const limit = limits.get(key) || { count: 0, until: now + duration };
    if (limits.size >= 10000 && !limits.has(key)) return true;
    limits.set(key, limit);
    return ++limit.count > maximum;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const pathname = req.url?.split("?")[0];
    try {
      if (req.method === "GET" && pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && pathname === "/readyz") {
        json(res, options.ready() ? 200 : 503, { ready: options.ready() });
        return;
      }
      if (
        req.method === "GET" &&
        ["/", "/buy", "/activate"].includes(pathname || "")
      ) {
        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(page(pathname === "/activate", bridge.config.testMode));
        return;
      }
      if (req.method === "GET" && pathname === "/assets/onboarding.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
        return;
      }
      if (req.method === "GET" && pathname === "/assets/onboarding.css") {
        res.writeHead(200, { "Content-Type": "text/css" }).end(css);
        return;
      }
      if (req.method === "POST" && pathname === "/webhooks/lemon-squeezy") {
        bridge.accept(
          await body(req),
          String(req.headers["x-signature"] || ""),
        );
        json(res, 200, { accepted: true });
        options.wake();
        return;
      }
      if (pathname?.startsWith("/admin/")) {
        if (
          !equal(
            String(req.headers.authorization || ""),
            `Bearer ${adminSecret}`,
          )
        ) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        if (req.headers.origin && req.headers.origin !== origin) {
          json(res, 403, { error: "Origin rejected" });
          return;
        }
        if (req.method === "GET" && pathname === "/admin/status") {
          json(res, 200, bridge.status());
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const args = JSON.parse((await body(req, 4096)).toString("utf8"));
        if (pathname === "/admin/reconcile")
          bridge.enqueue(z.string().parse(args.subscription));
        else if (pathname === "/admin/hold")
          await bridge.hold(
            z.string().parse(args.subscription),
            z.string().parse(args.reference),
            z.string().parse(args.reason),
          );
        else if (pathname === "/admin/release-hold")
          bridge.releaseHold(
            z.string().parse(args.resource),
            z.string().parse(args.reason),
          );
        else if (pathname === "/admin/retrieval-grant") {
          const grant = bridge.retrievalGrant(
            z.string().parse(args.subscription),
          );
          json(res, 200, {
            url: `${origin}/activate#claim=${grant.token}`,
            expires: new Date(grant.expires).toISOString(),
          });
          return;
        } else {
          res.writeHead(404).end();
          return;
        }
        options.wake();
        json(res, 202, { accepted: true });
        return;
      }
      if (
        req.method === "POST" &&
        ["/checkout", "/license"].includes(pathname || "")
      ) {
        if (req.headers.origin !== origin) {
          json(res, 403, { error: "Origin rejected" });
          return;
        }
        if (
          limited(
            req,
            pathname!,
            pathname === "/checkout" ? 100 : 600,
            pathname === "/checkout" ? 3600000 : 60000,
          )
        ) {
          res.setHeader("Retry-After", "60");
          json(res, 429, { error: "Please retry shortly" });
          return;
        }
        await body(req, 4096);
        if (pathname === "/checkout") {
          const checkout = await bridge.checkout(`${origin}/activate`);
          res.setHeader(
            "Set-Cookie",
            `deck_claim=${checkout.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? "; Secure" : ""}`,
          );
          json(res, 200, { url: checkout.url });
          return;
        }
        const bearer = String(req.headers.authorization || "").replace(
          /^Bearer /,
          "",
        );
        const cookie = /(?:^|;\s*)deck_claim=([A-Za-z0-9_-]{43})(?:;|$)/.exec(
          String(req.headers.cookie || ""),
        )?.[1];
        try {
          json(res, 200, await bridge.retrieve(bearer || cookie || ""));
        } catch (e) {
          json(
            res,
            e instanceof Error &&
              e.message === "Invalid or expired retrieval token"
              ? 401
              : 503,
            { error: "License retrieval unavailable" },
          );
        }
        return;
      }
      res.writeHead(404).end();
    } catch {
      json(res, pathname === "/checkout" ? 503 : 400, {
        error: "Request rejected",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
