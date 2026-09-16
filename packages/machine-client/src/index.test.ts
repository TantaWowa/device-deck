import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachineTransport, normalizeMachineEndpoint } from './index';

const id = '93c65aaa-3727-42e5-b91f-2d16ee1d4b4d';
const publicKey = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x'.repeat(43) };
const identity = { id, name: 'Studio', version: 'test', publicKey };
const validGrant = () => Promise.resolve({ token: 'machine-only', expiresAt: new Date(Date.now() + 60_000).toISOString() });
test('normalizes origins and rejects credentials, paths and non-HTTP schemes', () => {
  assert.equal(normalizeMachineEndpoint('https://STUDIO.example:443/'), 'https://studio.example');
  assert.equal(normalizeMachineEndpoint('http://[::1]:47831'), 'http://[::1]:47831');
  for (const endpoint of ['https://u:p@host', 'https://host/path', 'https://host?token=a', 'file:///etc/passwd', 'host:3000'])
    assert.throws(() => normalizeMachineEndpoint(endpoint));
});
test('checks pinned machine before requesting credentials and never follows redirects or sends cookies', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let grants = 0;
  const client = createMachineTransport({ endpoint: 'https://studio.example', expectedMachineId: id, expectedPublicKey: publicKey,
    getGrant: async () => { grants++; return validGrant(); }, fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(calls.length === 1 ? identity : { ok: true });
    },
  });
  assert.deepEqual(await client.operation('inventory', {}), { ok: true });
  assert.equal(grants, 1);
  assert.equal(new Headers(calls[0].init?.headers).has('Authorization'), false);
  assert.equal(new Headers(calls[1].init?.headers).get('Authorization'), 'Bearer machine-only');
  assert.equal(calls[1].init?.credentials, 'omit');
  assert.equal(calls[1].init?.redirect, 'error');
  client.dispose();
});
test('wrong machine identity receives no credential or control request', async () => {
  let calls = 0;
  const client = createMachineTransport({ endpoint: 'https://studio.example', expectedMachineId: id,
    getGrant: () => { assert.fail('must not mint a grant for the wrong machine'); },
    fetch: async () => { calls++; return Response.json({ ...identity, id: 'acb897c4-37c4-43d3-b2fa-6247556b5ad7' }); },
  });
  await assert.rejects(client.operation('inventory'), /different machine/);
  assert.equal(calls, 1);
});
test('disposing while a grant is pending prevents sending a stale control', async () => {
  let finish!: (value: Awaited<ReturnType<typeof validGrant>>) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const client = createMachineTransport({ endpoint: 'https://studio.example', getGrant: () => {
    started(); return new Promise(resolve => { finish = resolve; });
  }, fetch: async () => { calls++; return Response.json(identity); } });
  const operation = client.operation('inventory');
  await ready;
  client.dispose();
  finish(await validGrant());
  await assert.rejects(operation, /abort/i);
  assert.equal(calls, 1);
});
test('failed controls are not replayed and cross-origin blob URLs are rejected', async () => {
  let calls = 0;
  const client = createMachineTransport({ endpoint: 'https://studio.example', getGrant: validGrant,
    fetch: async () => ++calls === 1 ? Response.json(identity) : Response.json({ message: 'Expired' }, { status: 401 }),
  });
  await assert.rejects(client.operation('inventory'), /Expired/);
  assert.equal(calls, 2);
  const goodClient = createMachineTransport({ endpoint: 'https://studio.example', getGrant: validGrant,
    fetch: async () => Response.json(identity),
  });
  await assert.rejects(goodClient.getBlob('https://elsewhere.example/v1/frame'), /Invalid machine API path/);
});

test('caller cancellation rejects during grant acquisition and later refresh never dispatches input', async () => {
  let finish!: (value: Awaited<ReturnType<typeof validGrant>>) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController();
  let calls = 0;
  const client = createMachineTransport({ endpoint: 'https://studio.example', getGrant: () => {
    started(); return new Promise(resolve => { finish = resolve; });
  }, fetch: async () => { calls++; return Response.json(identity); } });
  const input = client.operation('remote.input', { key: 'Home' }, controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(input, /abort/i);
  finish(await validGrant());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  client.dispose();
});
