import { mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Keygen, relation } from './keygen.mjs';
const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
const client = new Keygen();
const names = ['DEVICE_DECK_CONCURRENT_SESSIONS', 'DEVICE_DECK_RECORDING_ANNOTATIONS'];
const managedBy = 'device-deck-release-tools';
await mkdir('work/release-secrets', { recursive: true, mode: 0o700 });
const lock = await open('work/release-secrets/provision.lock', 'wx', 0o600).catch(() => { throw new Error('A provisioning run is already active; inspect work/release-secrets/provision.lock.'); });
try {
  await lock.writeFile(String(process.pid));
  const [account, plan, products, policies, existingEntitlements] = await Promise.all([
    client.request(''), client.request('/plan'), client.list('/products'), client.list('/policies'), client.list('/entitlements'),
  ]);
  // Keygen account meta contains base64-encoded public keys (never private keys).
  const publicKey = Buffer.from(account.data.meta?.keys?.ed25519 || '', 'base64').toString('utf8');
  if (!/^[a-f0-9]{64}$/i.test(publicKey || '')) throw new Error('Account Ed25519 public key is unavailable or invalid.');
  const modes = ['live', 'test'];
  const missing = modes.filter(mode => !products.some(p => p.attributes.code === (mode === 'live' ? 'device-deck' : 'device-deck-test'))).length;
  if (plan.data.attributes.maxProducts != null && products.length + missing > plan.data.attributes.maxProducts) throw new Error('The existing plan has insufficient product slots. No upgrade was attempted.');
  console.log(JSON.stringify({ plan: plan.data.attributes.name, productsUsed: products.length, productsToCreate: missing, apply: values.apply }));
  if (!values.apply) { console.log('Add --apply to create Device Deck products, policies and entitlements. Existing unrelated products are never changed.'); process.exitCode = 0; }
  else {
    const entitlements = [];
    for (const code of names) entitlements.push(existingEntitlements.find(e => e.attributes.code === code) || await client.create('entitlements', { name: code.replaceAll('_', ' '), code, metadata: { managedBy } }));
    const output = {};
    for (const mode of modes) {
      const code = mode === 'live' ? 'device-deck' : 'device-deck-test';
      const product = products.find(p => p.attributes.code === code) || await client.create('products', { name: mode === 'live' ? 'Device Deck' : 'Device Deck Test', code, distributionStrategy: mode === 'live' ? 'OPEN' : 'LICENSED', platforms: ['macOS'], metadata: { managedBy, deviceDeckMode: mode } });
      if (product.attributes.metadata?.managedBy !== managedBy || product.attributes.metadata?.deviceDeckMode !== mode) throw new Error(`Product ${code} exists but is not managed by this setup; review its configuration.`);
      const trust = { mode, accountId: client.accountId, productId: product.id, publicKey };
      for (const tier of ['pro', 'trial']) {
        const name = `Device Deck ${mode} ${tier}`;
        const wanted = { name, duration: (tier === 'trial' ? 14 : 30) * 86400, strict: true, floating: false, scheme: null, protected: true, maxMachines: 1, requireProductScope: true, requireFingerprintScope: true, requireHeartbeat: false, requireCheckIn: false, authenticationStrategy: 'LICENSE', expirationBasis: 'FROM_CREATION', expirationStrategy: 'REVOKE_ACCESS', transferStrategy: 'KEEP_EXPIRY', overageStrategy: 'NO_OVERAGE', metadata: { managedBy, deviceDeckMode: mode, deviceDeckTier: tier } };
        const policy = policies.find(p => p.attributes.name === name && p.relationships.product.data.id === product.id) || await client.create('policies', wanted, { product: relation('products', product.id) });
        for (const [key, value] of Object.entries(wanted)) if (key !== 'metadata' && JSON.stringify(policy.attributes[key]) !== JSON.stringify(value)) throw new Error(`Policy ${name} differs at ${key}; review before changing live policy.`);
        const attached = await client.list(`/policies/${policy.id}/entitlements`);
        const add = entitlements.filter(e => !attached.some(a => a.id === e.id));
        if (add.length) await client.request(`/policies/${policy.id}/entitlements`, { method: 'POST', body: { data: add.map(e => ({ type: 'entitlements', id: e.id })) } });
        trust[tier === 'pro' ? 'proPolicyId' : 'trialPolicyId'] = policy.id;
      }
      output[mode] = trust;
    }
    await mkdir('config/releases', { recursive: true });
    await writeFile('config/releases/keygen.json', JSON.stringify(output, null, 2) + '\n');
    let publicSigningKey;
    try { publicSigningKey = JSON.parse(await readFile('config/releases/distribution.json', 'utf8')).publicKey; }
    catch (error) {
      if(error.code !== 'ENOENT') throw error;
      const { privateKey, publicKey: publicObject } = generateKeyPairSync('ed25519');
      await writeFile('work/release-secrets/release-signing.pem', privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
      publicSigningKey = publicObject.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
      await writeFile('config/releases/distribution.json', JSON.stringify({ schema: 1, publicKey: publicSigningKey }, null, 2) + '\n');
    }
    console.log(JSON.stringify({ configured: Object.fromEntries(Object.entries(output).map(([mode, t]) => [mode, { productId: t.productId, proPolicyId: t.proPolicyId, trialPolicyId: t.trialPolicyId }])), publicSigningKey, privateSigningKeyFile: 'work/release-secrets/release-signing.pem' }));
  }
} finally { await lock.close(); await rm('work/release-secrets/provision.lock', { force: true }); }
