import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { CloudService } from '../../cloud/src/service';
import { cloudServer } from '../../cloud/src/http';
import { createPortalSigner } from '../../cloud/src/signing';
import { keys, MemoryMachineStore } from '../../cloud/src/test-fixtures';
import { CloudError } from '../../cloud/src/errors';
import { MachineAuthority } from './network';
import { createService } from './server';
import { DeckService } from './local/service';
import { createMachineTransport } from '../../../packages/machine-client/src';
import type { MachineGrant, MachineIdentity, MachineRecord } from '../../../packages/core/src/hub';
import type { Operation } from '../../../packages/core/src/local/types';

const portal = 'https://portal.example.test';
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
class IntegrationDeck extends DeckService {
  commands: Operation[] = [];
  override async execute(operation: Operation) { this.commands.push(operation); return { ready: true }; }
  override async previewSource() { return Buffer.from([255, 216, 255, 217]); }
}

test('cloud registry, machine daemon and browser transport complete pairing, direct access and bounded removal', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'device-deck-hub-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now();
  const service = new CloudService(new MemoryMachineStore(), await createPortalSigner(portal, keys().privateKey), () => now);
  const cloud = cloudServer({ service, portalOrigin: portal, auth: { async authenticate(token) {
    if (!['alice-login', 'bob-login'].includes(token)) throw new CloudError(401, 'Sign in.');
    return { uid: token.split('-')[0] };
  } } });
  const cloudUrl = await listen(cloud);
  t.after(() => close(cloud));
  const authority = new MachineAuthority(directory, () => now, async url => {
    assert.equal(String(url), `${portal}/api/v1/public-key`);
    return fetch(`${cloudUrl}/api/v1/public-key`);
  });
  const deck = new IntegrationDeck(directory);
  deck.config.config.network = { host: '0.0.0.0', allowedHosts: [], allowedOrigins: [], hubOrigin: portal };
  const daemon = createService(deck, 'native-secret', directory, { authority, bindHost: '0.0.0.0' });
  const endpoint = await listen(daemon);
  t.after(() => close(daemon));
  async function account<T>(route: string, method = 'GET', body?: unknown, login = 'alice-login'): Promise<T> {
    const response = await fetch(`${cloudUrl}/api/v1${route}`, { method,
      headers: { Authorization: `Bearer ${login}`, Origin: portal, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
    return data;
  }
  assert.equal((await fetch(`${endpoint}/v1/health`)).status, 401);
  const identity: MachineIdentity = await (await fetch(`${endpoint}/v1/machine`)).json();
  const preflight = await fetch(`${endpoint}/v1/hub/pair`, { method: 'OPTIONS', headers: {
    Origin: portal, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-device-deck',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), portal);
  const challenge = await (await fetch(`${endpoint}/v1/hub/pairing-code`, { method: 'POST',
    headers: { Authorization: 'Bearer native-secret', 'Content-Type': 'application/json' }, body: '{}',
  })).json();
  const pending = await account<{ token: string }>('/pairings', 'POST', { machineId: identity.id, publicKey: identity.publicKey });
  const paired = await fetch(`${endpoint}/v1/hub/pair`, { method: 'POST', headers: { Origin: portal, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: challenge.code, token: pending.token }),
  });
  assert.equal(paired.status, 200);
  const { receipt } = await paired.json();
  const { machine } = await account<{ machine: MachineRecord }>('/machines', 'POST', { name: 'Studio', endpoint, receipt });
  assert.equal(machine.id, identity.id);
  await assert.rejects(account(`/machines/${machine.id}/grant`, 'POST', undefined, 'bob-login'), /404/);
  await assert.rejects(account('/machines', 'POST', { name: 'Replay', endpoint, receipt }), /409/);
  const seen: string[] = [];
  const transport = createMachineTransport({ endpoint, expectedMachineId: machine.id, expectedPublicKey: machine.publicKey,
    getGrant: () => account<MachineGrant>(`/machines/${machine.id}/grant`, 'POST'),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      assert.notEqual(headers.get('Authorization'), 'Bearer alice-login');
      headers.set('Origin', portal);
      seen.push(String(input));
      return fetch(input, { ...init, headers });
    },
  });
  t.after(() => transport.dispose());
  assert.deepEqual(await transport.operation('inventory'), { ready: true });
  assert.equal((await transport.getBlob('/v1/source-preview/camera')).size, 4);
  assert.deepEqual(deck.commands, ['inventory']);
  assert.ok(seen.every(url => url.startsWith(endpoint)));
  await account(`/machines/${machine.id}`, 'DELETE');
  await assert.rejects(account(`/machines/${machine.id}/grant`, 'POST'), /404/);
  now += 61_000;
  await assert.rejects(transport.operation('inventory'), /dashboard|unauthoriz|expired/i);
  assert.deepEqual(deck.commands, ['inventory']);
});
