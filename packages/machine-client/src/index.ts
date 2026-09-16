import type { Operation } from '../../core/src/local/types';
import { endpointSchema, grantSchema, machineIdentitySchema, type HubPublicKey, type MachineGrant } from '../../core/src/hub';

export function normalizeMachineEndpoint(input: string): string {
  const result = endpointSchema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues[0].message);
  return result.data;
}

export type MachineTransportOptions = {
  endpoint: string;
  getGrant: () => Promise<MachineGrant>;
  expectedMachineId?: string;
  expectedPublicKey?: HubPublicKey;
  /** Used by integration tests; browser fetch is the production default. */
  fetch?: typeof fetch;
};

export function createMachineTransport(options: MachineTransportOptions) {
  const endpoint = normalizeMachineEndpoint(options.endpoint);
  const request = options.fetch ?? globalThis.fetch;
  const lifetime = new AbortController();
  let pendingGrant: Promise<MachineGrant> | undefined;
  let currentGrant: MachineGrant | undefined;

  function signalFor(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  }
  async function checkedFetch(path: string, init: RequestInit, signal?: AbortSignal) {
    lifetime.signal.throwIfAborted();
    // Paths are data, never alternate origins or protocol-relative URLs.
    const url = new URL(path, endpoint);
    if (!path.startsWith('/v1/') || url.origin !== endpoint || !url.pathname.startsWith('/v1/') || url.hash)
      throw new Error('Invalid machine API path.');
    return request(url.href, { ...init, signal: signalFor(signal), credentials: 'omit', redirect: 'error', cache: 'no-store' });
  }
  async function errorFor(response: Response): Promise<Error> {
    const body = await response.json().catch(() => undefined);
    return new Error(typeof body?.message === 'string' ? body.message : `Machine returned ${response.status}.`);
  }
  async function verifyIdentity() {
    const response = await checkedFetch('/v1/machine', { method: 'GET' });
    if (!response.ok) throw await errorFor(response);
    const identity = machineIdentitySchema.parse(await response.json());
    if ((options.expectedMachineId && identity.id !== options.expectedMachineId) ||
        (options.expectedPublicKey && (identity.publicKey.x !== options.expectedPublicKey.x ||
          identity.publicKey.crv !== options.expectedPublicKey.crv || identity.publicKey.kty !== options.expectedPublicKey.kty)))
      throw new Error('This address belongs to a different machine. Pair it again before connecting.');
  }
  async function grant() {
    lifetime.signal.throwIfAborted();
    if (currentGrant && Date.parse(currentGrant.expiresAt) > Date.now() + 5_000) return currentGrant;
    if (!pendingGrant) {
      pendingGrant = (async () => {
        await verifyIdentity();
        lifetime.signal.throwIfAborted();
        const value = grantSchema.parse(await options.getGrant());
        lifetime.signal.throwIfAborted();
        if (Date.parse(value.expiresAt) <= Date.now()) throw new Error('Machine access expired. Connect again.');
        currentGrant = value;
        return value;
      })().finally(() => { pendingGrant = undefined; });
    }
    return pendingGrant;
  }
  async function authorized(path: string, init: RequestInit, signal?: AbortSignal) {
    const requestSignal = signalFor(signal);
    requestSignal.throwIfAborted();
    // A shared refresh can outlive one caller. Stop that caller immediately and
    // never dispatch its request when a slow connection later recovers.
    const credential = await new Promise<MachineGrant>((resolve, reject) => {
      const aborted = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', aborted, { once: true });
      void grant().then(resolve, reject).finally(() => requestSignal.removeEventListener('abort', aborted));
    });
    requestSignal.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential.token}`);
    headers.set('X-Device-Deck', 'local');
    const response = await checkedFetch(path, { ...init, headers }, requestSignal);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) currentGrant = undefined;
      // A request may have reached the device. Never replay controls automatically.
      throw await errorFor(response);
    }
    return response;
  }
  return {
    async operation<T = unknown>(name: Operation, args: unknown = {}, signal?: AbortSignal): Promise<T> {
      const deadline = name === 'remote.input' || name === 'remote.override'
        ? AbortSignal.any([AbortSignal.timeout(3_000), ...(signal ? [signal] : [])]) : signal;
      const response = await authorized(`/v1/operations/${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      }, deadline);
      return response.json() as Promise<T>;
    },
    async getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
      return (await authorized(path, { method: 'GET' }, signal)).blob();
    },
    async getJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
      return (await authorized(path, { method: 'GET' }, signal)).json() as Promise<T>;
    },
    dispose() { currentGrant = undefined; lifetime.abort(); },
  };
}

export type MachineTransport = ReturnType<typeof createMachineTransport>;
