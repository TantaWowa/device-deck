import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkMacUpdates, downloadMacUpdate } from "./mac-update";
const bytes = Buffer.from("installer fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
function release(version: string, prerelease = false) {
  return { tag_name: `v${version}`, prerelease, draft: false, assets: [{
    name: `device-deck-${version}-macos-arm64.pkg`, size: bytes.length,
    digest: `sha256:${sha256}`,
    browser_download_url: `https://github.com/TantaWowa/device-deck/releases/download/v${version}/device-deck-${version}-macos-arm64.pkg`,
  }] };
}
test("public updates select matching architecture and channel without credentials", async () => {
  const transport: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json([release("0.9.0-beta.1", true), release("0.8.0")]);
  };
  assert.equal((await checkMacUpdates({ transport, arch: "arm64" }))?.manifest.version, "0.9.0-beta.1");
  assert.equal((await checkMacUpdates({ transport, arch: "arm64", channel: "stable" }))?.manifest.version, "0.8.0");
  assert.equal(await checkMacUpdates({ transport, arch: "x64" }), undefined);
});
test("updates reject unverified assets, drafts and another repository", async () => {
  const bad = release("1.0.0"); bad.assets[0].digest = "";
  const other = release("2.0.0"); other.assets[0].browser_download_url = "https://github.com/other/repo/releases/download/v2.0.0/app.pkg";
  const draft = { ...release("3.0.0"), draft: true };
  assert.equal(await checkMacUpdates({ arch: "arm64", transport: async () => Response.json([bad, other, draft]) }), undefined);
});
test("downloads verify size and digest before publishing a local installer", async () => {
  const candidate = await checkMacUpdates({ arch: "arm64", transport: async () => Response.json([release("1.0.0")]) });
  assert.ok(candidate);
  const directory = await mkdtemp(path.join(os.tmpdir(), "free-installer-"));
  try {
    await assert.rejects(downloadMacUpdate(candidate, directory, async () => new Response("bad")), /checksum or size/);
    assert.deepEqual(await readdir(directory), []);
    const file = await downloadMacUpdate(candidate, directory, async () => new Response(bytes));
    assert.deepEqual(await readFile(file), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
