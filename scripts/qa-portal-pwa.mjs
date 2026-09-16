import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const directory = await mkdtemp(path.join(os.tmpdir(), 'device-deck-pwa-'));
await mkdir('outputs/portal-qa', { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'),
  '-out', path.join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer({ key: await readFile(path.join(directory, 'key.pem')), cert: await readFile(path.join(directory, 'cert.pem')) }, async (request, response) => {
  const url = new URL(request.url, 'https://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
    response.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end('{"error":"Authentication required"}'); return;
  }
  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (relative === 'app/' || relative === 'app') relative = 'app/index.html';
  if (!relative.startsWith('app/') || relative.includes('..')) { response.writeHead(404); response.end(); return; }
  try {
    const data = await readFile(path.join('dist', relative));
    response.writeHead(200, { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${origin}/app/`);
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker did not install.')), 15000))]));
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const session = await context.newCDPSession(page);
  const manifest = await session.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  const data = JSON.parse(manifest.data);
  assert.equal(data.display, 'standalone');
  assert.equal(data.scope, '/app/');
  for (const icon of data.icons) assert.equal((await page.request.get(`${origin}${icon.src}`)).status(), 200);
  await page.evaluate(async () => {
    await fetch('/api/v1/machines', { headers: { Authorization: 'Bearer qa-only' } });
    await fetch('/v1/source-preview/qa-feed');
  });
  const paths = await page.evaluate(async () => {
    const entries = await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)));
    return entries.flat();
  });
  assert.ok(paths.some(value => value.endsWith('.js')));
  assert.ok(paths.some(value => value.endsWith('.css')));
  assert.ok(paths.every(value => value.startsWith('/app/') && value !== '/app/firebase-config.json'));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.screenshot({ path: 'outputs/portal-qa/offline-shell.png', fullPage: true });
  console.log('PWA QA passed: production manifest/icons, HTTPS service worker installation, public shell assets cached, private requests excluded, and offline reload.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
