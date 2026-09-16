import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachineTransport, normalizeMachineEndpoint } from './index';
import type { Operation } from '../../core/src/local/types';

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

test('long captures and artifact downloads retain their full deadline without replaying requests', async (context) => {
  let elapsed = 0;
  const timers: { at: number; controller: AbortController }[] = [];
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController();
    timers.push({ at: elapsed + milliseconds, controller });
    return controller.signal;
  });
  const advance = (milliseconds: number) => {
    elapsed += milliseconds;
    for (const timer of timers) if (timer.at <= elapsed && !timer.controller.signal.aborted)
      timer.controller.abort(new DOMException('Request deadline elapsed', 'TimeoutError'));
  };
  const cases: { operation?: Operation; path?: string; deadline: number }[] = [
    { operation: 'captures.screenshot', deadline: 60_000 },
    { operation: 'recordings.stop', deadline: 180_000 },
    { operation: 'sessions.release', deadline: 180_000 },
    { operation: 'sessions.takeover', deadline: 180_000 },
    { operation: 'devices.simulator', deadline: 300_000 },
    { path: '/v1/artifacts/synthetic/file', deadline: 600_000 },
    { path: '/v1/preview/synthetic', deadline: 30_000 },
  ];
  for (const scenario of cases) {
    let started!: () => void, requestSignal: AbortSignal | undefined, requests = 0;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const client = createMachineTransport({ endpoint: 'https://studio.example', getGrant: validGrant, fetch: async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/machine') return Response.json(identity);
      requests++;
      requestSignal = init!.signal!;
      started();
      return new Promise<Response>((_, reject) => {
        const aborted = () => reject(requestSignal!.reason);
        requestSignal!.addEventListener('abort', aborted, { once: true });
        if (requestSignal!.aborted) aborted();
      });
    } });
    const outcome = (scenario.operation ? client.operation(scenario.operation) : client.getBlob(scenario.path!))
      .then(() => assert.fail('The delayed request must eventually time out.'), (error: unknown) => error);
    await ready;
    advance(scenario.deadline - 1);
    assert.equal(requestSignal!.aborted, false, `${scenario.operation || scenario.path} stopped before its allowed deadline`);
    advance(1);
    assert.equal((await outcome as Error).name, 'TimeoutError');
    assert.equal(requests, 1, 'Timeouts must never replay a request.');
    client.dispose();
  }
});

test('caller cancellation still immediately aborts a long artifact download', async () => {
  const caller = new AbortController();
  let ready!: () => void, requests = 0;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const client = createMachineTransport({ endpoint: 'https://studio.example', getGrant: validGrant, fetch: async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/machine') return Response.json(identity);
    requests++; ready();
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  } });
  const download = client.getBlob('/v1/artifacts/synthetic/file', caller.signal);
  await started;
  const rejected = assert.rejects(download, /user cancelled/);
  caller.abort(new Error('user cancelled'));
  await rejected;
  assert.equal(requests, 1);
  client.dispose();
});
