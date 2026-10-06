import assert from 'node:assert/strict';
import test from 'node:test';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Adapters } from './index';
import { configSchema, deviceSchema } from '../../core/src/local/types';

for (const os of ['ios', 'tvos'] as const) for (const fails of [false, true]) {
  test(`${os} screenshot reads an isolated file and cleans up on ${fails ? 'failure' : 'success'}`, async () => {
    const config = configSchema.parse({ schemaVersion: 1, settings: { folder: '/tmp/captures' } });
    const device = deviceSchema.parse({ id: 'sim', name: 'Simulator', platform: 'Apple', kind: 'virtual', connection: { type: 'simulator', os, udid: '0371776A-0FC2-4DD1-8831-8941C7D1088A' } });
    let file = '';
    const image = Buffer.from([137, 80, 78, 71]);
    const adapters = new Adapters(() => config, async (executable, args) => {
      assert.equal(executable, 'xcrun');
      file = args.at(-1)!;
      assert.equal(path.isAbsolute(file), true);
      assert.equal(args.includes('--display=external'), os === 'tvos');
      if (fails) throw new Error('capture failed');
      await writeFile(file, image);
      return { stdout: Buffer.from('status text, not image bytes'), stderr: '' };
    });
    if (fails) await assert.rejects(adapters.screenshot(device), /capture failed/);
    else assert.deepEqual(await adapters.screenshot(device), image);
    await assert.rejects(access(path.dirname(file)));
  });
}
