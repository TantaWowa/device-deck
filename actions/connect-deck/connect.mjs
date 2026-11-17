import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

class ConnectionError extends Error {}
class AlreadyConnected extends Error {}

function origin(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\/[^/?#]+\/?$/i.test(value) || /[\s\\]/.test(value)) throw new Error();
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        ['0.0.0.0', '[::]'].includes(url.hostname)) throw new Error();
    return url.origin;
  } catch {
    throw new ConnectionError('Use a trusted HTTPS origin without a path, credentials, query, or fragment.');
  }
}

function grantToken(grant) {
  try {
    if (typeof grant !== 'string' || grant.length > 16384) throw new Error();
    const value = JSON.parse(grant);
    if (!value || Array.isArray(value) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error();
    return value.token;
  } catch {
    throw new ConnectionError('An absent connection requires valid dedicated grant JSON.');
  }
}

function execute(cli, args, env, message, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(cli, args, { env, timeout: 210000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        let conflict = false;
        try { conflict = args[0] === 'decks' && args[1] === 'add' && error.code === 1 && JSON.parse(stderr).error === 'deck-already-connected'; } catch {}
        reject(conflict ? new AlreadyConnected() : new ConnectionError(message));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new ConnectionError('The installed Device Deck CLI returned an invalid response.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function ensureDeck({ name, address, grant, cli, env = process.env }) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || name === 'local')
    throw new ConnectionError('Use a valid remote Deck name other than local.');
  const expectedOrigin = origin(address);
  const executable = cli || env.DEVICE_DECK_CLI || 'devdeck';
  if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0'))
    throw new ConnectionError('Use an installed devdeck executable path.');
  const childEnv = { ...env };
  delete childEnv.INPUT_GRANT;
  const list = async () => {
    const result = await execute(executable, ['decks', 'list', '--deck', 'local', '--json'], childEnv,
      'Unable to inspect connections through the installed Device Deck CLI.');
    if (!result || !Array.isArray(result.decks) || result.decks.some(deck => !deck || typeof deck.name !== 'string'))
      throw new ConnectionError('The installed Device Deck CLI returned an invalid connection list.');
    const matches = result.decks.filter(deck => deck.name === name);
    if (matches.length > 1) throw new ConnectionError('The connection name is not unique.');
    const deck = matches[0];
    if (!deck) return undefined;
    if (origin(deck.address) !== expectedOrigin)
      throw new ConnectionError('An existing connection uses a different origin. No connection was changed.');
    if (typeof deck.machineId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(deck.machineId))
      throw new ConnectionError('The installed Device Deck CLI returned an invalid machine identity.');
    return { name, address: expectedOrigin, machineId: deck.machineId };
  };
  let deck = await list();
  let created = false;
  if (!deck) {
    const token = grantToken(grant);
    try {
      await execute(executable, ['decks', 'add', name, '--address', expectedOrigin,
        '--token-file', '/dev/stdin', '--deck', 'local', '--json'], childEnv,
      'Unable to add the Deck connection. Check the dedicated grant and host connectivity.', JSON.stringify({ token }));
      created = true;
    } catch (error) {
      if (!(error instanceof AlreadyConnected)) throw error;
    }
    deck = await list();
    if (!deck) throw new ConnectionError('The requested connection was not installed.');
  }
  const devices = await execute(executable, ['devices', '--deck', name, '--json'], childEnv,
    'The remote Deck did not verify authenticated access. Check connectivity and grant authorization.');
  if (!Array.isArray(devices)) throw new ConnectionError('The installed Device Deck CLI returned an invalid device list.');
  return { ...deck, created };
}

async function main() {
  try {
    const result = await ensureDeck({ name: process.env.INPUT_NAME, address: process.env.INPUT_ADDRESS,
      grant: process.env.INPUT_GRANT, cli: process.env.INPUT_CLI });
    if (process.env.GITHUB_OUTPUT) {
      try {
        await appendFile(process.env.GITHUB_OUTPUT,
          `name=${result.name}\naddress=${result.address}\nmachine-id=${result.machineId}\ncreated=${result.created}\n`);
      } catch { throw new ConnectionError('Unable to write the action outputs.'); }
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof ConnectionError ? error.message : 'Unable to configure the Deck connection.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
