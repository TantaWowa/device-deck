// Run with Firebase Auth emulator on 127.0.0.1:9099. No real hardware or cloud
// account is touched: only this script imports test adapters and an in-memory registry.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { CloudService } from '../apps/cloud/src/service';
import { cloudServer } from '../apps/cloud/src/http';
import { createPortalSigner } from '../apps/cloud/src/signing';
import { FirebaseAuthenticator } from '../apps/cloud/src/auth';
import { keys, MemoryMachineStore } from '../apps/cloud/src/test-fixtures';
import { DeckService } from '../apps/daemon/src/local/service';
import { createService } from '../apps/daemon/src/server';
import { MachineAuthority } from '../apps/daemon/src/network';
import { Adapters } from '../packages/adapters/src';
import type { Config, Device, DeviceConfig, Input, SourceConfig } from '../packages/core/src/local/types';
import { LocalDevelopmentLicense } from './local-license';

process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const projectId = 'demo-device-deck-portal';
const origin = 'http://127.0.0.1:5185';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'device-deck-portal-qa-'));
await mkdir('outputs/portal-qa', { recursive: true });
const commands: { machine: number; key?: string; text?: string }[] = [];
const admin = initializeApp({ projectId }, `portal-qa-${randomUUID()}`);
const store = new MemoryMachineStore();
const service = new CloudService(store, await createPortalSigner(origin, keys().privateKey));
const cloud = cloudServer({ service, auth: new FirebaseAuthenticator(getAuth(admin)), portalOrigin: origin });
const daemons: ReturnType<typeof createService>[] = [];
const decks: DeckService[] = [];
const authorities: MachineAuthority[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
const errors: string[] = [];
try {
  await fetch('http://127.0.0.1:9099/', { signal: AbortSignal.timeout(2000) });
  await new Promise<void>(resolve => cloud.listen(8085, '127.0.0.1', resolve));
  for (let machine = 0; machine < 2; machine++) {
    let config: Config;
    class FixtureAdapters extends Adapters {
      override async diagnostics() { return []; }
      override async inspect(device: DeviceConfig): Promise<Device> {
        return { ...device, online: true, locked: false, healthDetail: 'Portal QA device', capabilities: ['key', 'text', 'preview'] };
      }
      override async inspectSources(sources: SourceConfig[]) {
        return sources.map(source => ({ ...source, status: 'connected' as const, detail: 'QA feed', deviceName: 'Living room TV' }));
      }
      override async input(_device: DeviceConfig, input: Pick<Input, 'key' | 'text' | 'x' | 'y'>) {
        commands.push({ machine, key: input.key, text: input.text });
      }
    }
    class FixtureDeck extends DeckService {
      override async preview() { return this.previewSource(); }
      override async previewSource() {
        return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      }
    }
    const directory = path.join(temporary, String(machine));
    await mkdir(directory);
    const deck = new FixtureDeck(directory, undefined, new FixtureAdapters(() => config), undefined, new LocalDevelopmentLicense());
    await deck.init();
    decks.push(deck);
    config = structuredClone(deck.config.config);
    config.network = { host: '0.0.0.0', allowedHosts: [], allowedOrigins: [], hubOrigin: origin };
    config.devices = [{ id: 'same-device-id', name: 'Living room TV', model: 'Roku Ultra', platform: 'Roku', kind: 'physical', visibility: 'local', captureSourceId: 'screen', connection: { type: 'roku', host: '127.0.0.1', serial: `qa-${machine}` } }];
    config.sources = [{ id: 'screen', name: 'HDMI feed', kind: 'usb', uniqueId: `qa-feed-${machine}` }];
    config.settings.folder = path.join(directory, 'captures');
    await deck.config.save(config, deck.config.revision);
    const authority = new MachineAuthority(directory);
    const daemon = createService(deck, `qa-native-${machine}`, directory, { authority });
    await new Promise<void>(resolve => daemon.listen(47839 + machine, '127.0.0.1', resolve));
    daemons.push(daemon); authorities.push(authority);
  }
  vite = await createViteServer({ root: 'apps/portal', configFile: 'apps/portal/vite.config.ts',
    server: { host: '127.0.0.1', port: 5185, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8085' } },
    plugins: [{ name: 'qa-public-config', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/app/firebase-config.json') return next();
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ apiKey: 'demo-portal', authDomain: 'localhost', projectId, appId: '1:123:web:portal-qa', authEmulatorUrl: 'http://127.0.0.1:9099' }));
      });
    } }],
  });
  await vite.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http://127.0.0.1:478')) {
      const authorization = request.headers().authorization;
      if (authorization) {
        const claims = JSON.parse(Buffer.from(authorization.split(' ')[1].split('.')[1], 'base64url').toString());
        assert.equal(claims.purpose, 'access');
        assert.equal(claims.iss, origin);
      }
    }
  });
  await page.goto(`${origin}/app/`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await page.screenshot({ path: 'outputs/portal-qa/phone-sign-in.png', fullPage: true });
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  const email = `qa-${randomUUID()}@example.test`;
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('QA-password-789!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your machines' })).toBeVisible();
  async function addMachine(machine: number, name: string) {
    const { code } = await authorities[machine].issueCode(origin);
    await page.getByRole('button', { name: 'Add machine', exact: true }).click();
    await page.getByLabel('Machine name', { exact: true }).fill(name);
    await page.getByLabel(/^Machine address/).fill(`http://127.0.0.1:${47839 + machine}`);
    await page.getByLabel('Pairing code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await addMachine(0, 'Studio Mac');
  await addMachine(1, 'Office Mac');
  await expect(page.getByText('Reachable from this browser', { exact: true })).toHaveCount(2);
  await page.screenshot({ path: 'outputs/portal-qa/phone-machines.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'outputs/portal-qa/desktop-machines.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.machine-card').filter({ has: page.getByRole('heading', { name: 'Studio Mac', exact: true }) }).getByRole('button', { name: 'Feeds & controls' }).click();
  await expect(page.getByAltText('Live preview of HDMI feed')).toBeVisible();
  await page.getByRole('button', { name: 'Remote', exact: true }).click();
  const remote = page.getByRole('dialog', { name: 'Remote for Living room TV' });
  await expect(remote).toBeVisible();
  await expect(remote.getByAltText('Live preview of Living room TV')).toBeVisible();
  await page.screenshot({ path: 'outputs/portal-qa/phone-remote.png', fullPage: true });
  const tooSmall = await remote.locator('[data-remote-key]').evaluateAll(buttons => buttons.filter(button => {
    const rect = button.getBoundingClientRect(); return rect.width < 44 || rect.height < 44;
  }).map(button => button.getAttribute('data-remote-key')));
  assert.deepEqual(tooSmall, [], 'Phone remote targets must be at least 44px.');
  await remote.locator('[data-remote-key="Home"]').click();
  await expect.poll(() => commands.length).toBe(1);
  assert.equal(commands[0].machine, 0);
  await page.getByRole('button', { name: 'Close remote', exact: true }).last().click();
  await page.getByRole('button', { name: 'Machines', exact: true }).click();
  await page.locator('.machine-card').filter({ has: page.getByRole('heading', { name: 'Office Mac', exact: true }) }).getByRole('button', { name: 'Feeds & controls' }).click();
  await page.getByRole('button', { name: 'Remote', exact: true }).click();
  await page.locator('[data-remote-key="Home"]').click();
  await expect.poll(() => commands.length).toBe(2);
  assert.equal(commands[1].machine, 1, 'A same-named device on another machine must use its own reservation.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: 'Close remote', exact: true }).last().click();
  await page.getByRole('button', { name: 'Machines', exact: true }).click();
  await page.getByRole('button', { name: 'Options for Office Mac' }).click();
  await page.getByRole('button', { name: 'Edit machine', exact: true }).click();
  await page.getByLabel('Machine name', { exact: true }).fill('Office workstation');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Office workstation' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText(/Your browser is offline/)).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Options for Office workstation' }).click();
  await page.getByRole('button', { name: 'Remove machine', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove machine', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Office workstation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  const saved = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('device-deck-hub-machines:')));
  assert.deepEqual(saved, []);
  assert.deepEqual(errors, []);
  console.log('Portal QA passed: Firebase email signup, two machine pairings, direct previews and controls, machine isolation, phone targets, edit, remove, offline banner and logout cleanup. Screenshots: outputs/portal-qa/');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: 'outputs/portal-qa/failure.png', fullPage: true });
  console.error(await page?.locator('body').innerText().catch(() => 'Page unavailable'));
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  for (const server of [cloud, ...daemons]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const deck of decks) await deck.close();
  await deleteApp(admin);
  await rm(temporary, { recursive: true, force: true });
}
