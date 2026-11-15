import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkMacUpdates, compareVersions, downloadMacUpdate } from "./mac-update";

const installer = Buffer.from("installer fixture");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const installerDigest = digest(installer);
const releasesURL = "https://api.github.com/repos/TantaWowa/device-deck/releases?per_page=100";
type Asset = { name: string; size: number; digest: string; browser_download_url: string };
type ReleaseFixture = { tag_name: string; prerelease: boolean; draft: boolean; assets: Asset[] };
type Fixture = { release: ReleaseFixture; metadataURL: string; metadataBytes: Buffer };

function release(version: string, options: {
  arch?: "arm64" | "x64";
  prerelease?: boolean;
  draft?: boolean;
  metadata?: Record<string, unknown>;
  metadataValue?: unknown;
  rawMetadata?: string;
} = {}): Fixture {
  const arch = options.arch || "arm64", filename = `device-deck-${version}-macos-${arch}.pkg`;
  const assetURL = (name: string) => `https://github.com/TantaWowa/device-deck/releases/download/v${version}/${name}`;
  const metadataName = filename.replace(/\.pkg$/, ".json");
  const metadata = Object.hasOwn(options, "metadataValue") ? options.metadataValue : {
    schemaVersion: 1, application: "com.tantawowa.device-deck", version, arch,
    file: filename, bytes: installer.length, sha256: installerDigest,
    signing: "developer-id-notarized", media: "bundled", ...options.metadata,
  };
  const metadataBytes = Buffer.from(options.rawMetadata ?? JSON.stringify(metadata));
  return {
    release: {
      tag_name: `v${version}`, prerelease: options.prerelease ?? version.includes("-"), draft: options.draft ?? false,
      assets: [
        { name: filename, size: installer.length, digest: `sha256:${installerDigest}`, browser_download_url: assetURL(filename) },
        { name: metadataName, size: metadataBytes.length, digest: `sha256:${digest(metadataBytes)}`, browser_download_url: assetURL(metadataName) },
      ],
    },
    metadataURL: assetURL(metadataName), metadataBytes,
  };
}

function transportFor(fixtures: Fixture[], responses = new Map<string, () => Response | Promise<Response>>(), requested: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    assert.equal(new Headers(init?.headers).has("Authorization"), false, "Public updates must not need account credentials");
    const override = responses.get(url);
    if (override) return override();
    if (url === releasesURL) return Response.json(fixtures.map(fixture => fixture.release));
    const fixture = fixtures.find(candidate => candidate.metadataURL === url);
    assert.ok(fixture, `Unexpected request: ${url}`);
    return new Response(new Uint8Array(fixture.metadataBytes));
  };
}

async function candidate() {
  const value = await checkMacUpdates({ arch: "arm64", transport: transportFor([release("1.0.0")]) });
  assert.ok(value);
  return value;
}

test("public updates select matching architecture and channel without credentials", async () => {
  const transport = transportFor([
    release("0.8.0"), release("0.9.0-beta.2"), release("0.9.0-beta.10"),
    release("1.0.0", { arch: "x64" }), release("2.0.0", { draft: true }),
  ]);
  const beta = await checkMacUpdates({ transport, arch: "arm64" });
  assert.equal(beta?.manifest.version, "0.9.0-beta.10");
  assert.equal(beta?.manifest.signing, "developer-id-notarized");
  assert.equal((await checkMacUpdates({ transport, arch: "arm64", channel: "stable" }))?.manifest.version, "0.8.0");
  assert.equal((await checkMacUpdates({ transport, arch: "x64" }))?.manifest.version, "1.0.0");
  assert.equal(await checkMacUpdates({ transport, arch: "riscv64" }), undefined);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.10"), 1);
});

test("update discovery rejects unverified assets, incomplete releases and foreign URLs", async (t) => {
  const cases: Array<[string, (fixture: Fixture) => void]> = [
    ["missing installer digest", f => { f.release.assets[0].digest = ""; }],
    ["missing metadata", f => { f.release.assets.pop(); }],
    ["missing metadata digest", f => { f.release.assets[1].digest = ""; }],
    ["invalid installer size", f => { f.release.assets[0].size = 0; }],
    ["oversized metadata declaration", f => { f.release.assets[1].size = 65537; }],
    ["foreign installer repository", f => { f.release.assets[0].browser_download_url = "https://github.com/other/repo/releases/download/v1.0.0/app.pkg"; }],
    ["foreign metadata repository", f => { f.release.assets[1].browser_download_url = f.metadataURL.replace("TantaWowa", "other"); }],
    ["installer URL tag mismatch", f => { f.release.assets[0].browser_download_url = f.release.assets[0].browser_download_url.replace("/v1.0.0/", "/v2.0.0/"); }],
    ["installer URL credentials", f => { f.release.assets[0].browser_download_url = f.release.assets[0].browser_download_url.replace("https://", "https://user:secret@"); }],
    ["draft release", f => { f.release.draft = true; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const fixture = release("1.0.0"); mutate(fixture);
    assert.equal(await checkMacUpdates({ arch: "arm64", transport: transportFor([fixture]) }), undefined);
  });
});

test("only matching signed, bundled metadata can authorize an update", async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["unsigned application", { signing: "ad-hoc" }],
    ["external encoder", { media: "external" }],
    ["another product", { application: "com.other.application" }],
    ["another version", { version: "2.0.0" }],
    ["another architecture", { arch: "x64" }],
    ["another installer filename", { file: "device-deck-1.0.0-macos-x64.pkg" }],
    ["another installer checksum", { sha256: "0".repeat(64) }],
    ["another installer size", { bytes: installer.length + 1 }],
  ];
  for (const [name, metadata] of cases) await t.test(name, async () => {
    assert.equal(await checkMacUpdates({ arch: "arm64", transport: transportFor([release("1.0.0", { metadata })]) }), undefined);
  });
});

test("metadata bytes must match the GitHub asset digest and size", async (t) => {
  for (const [name, alter] of [
    ["digest mismatch", (bytes: Buffer) => Buffer.from(bytes.toString().replace("bundled", "changed"))],
    ["truncated metadata", (bytes: Buffer) => bytes.subarray(0, bytes.length - 1)],
    ["oversized metadata body", (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("extra")])],
  ] satisfies Array<[string, (bytes: Buffer) => Buffer]>) await t.test(name, async () => {
    const fixture = release("1.0.0");
    const responses = new Map([[fixture.metadataURL, () => new Response(new Uint8Array(alter(fixture.metadataBytes)))]]);
    assert.equal(await checkMacUpdates({ arch: "arm64", transport: transportFor([fixture], responses) }), undefined);
  });
});

test("discovery chooses the next complete candidate after newer invalid releases", async () => {
  const newest = release("5.0.0", { metadata: { signing: "ad-hoc" } });
  const corrupted = release("4.0.0"); corrupted.release.assets[1].digest = `sha256:${"0".repeat(64)}`;
  const external = release("3.0.0", { metadata: { media: "external" } });
  const valid = release("2.0.0");
  const requested: string[] = [];
  const result = await checkMacUpdates({ arch: "arm64", transport: transportFor([valid, external, corrupted, newest, release("1.0.0")], undefined, requested) });
  assert.equal(result?.manifest.version, "2.0.0");
  assert.deepEqual(requested, [releasesURL, newest.metadataURL, corrupted.metadataURL, external.metadataURL, valid.metadataURL]);
});

test("malformed release entries do not hide a valid candidate", async () => {
  const valid = release("1.0.0");
  const responses = new Map([[releasesURL, () => Response.json([
    null, "invalid", {}, { tag_name: "v3.0.0", assets: {} },
    { tag_name: "v2.0.0", assets: [null, "invalid", {}] }, valid.release,
  ])]]);
  assert.equal((await checkMacUpdates({ arch: "arm64", transport: transportFor([valid], responses) }))?.manifest.version, "1.0.0");
});

test("unreadable or malformed metadata does not hide an older valid update", async (t) => {
  const valid = release("1.0.0");
  for (const [name, fixture, response] of [
    ["invalid JSON", release("2.0.0", { rawMetadata: "{" }), undefined],
    ["JSON null", release("2.0.0", { metadataValue: null }), undefined],
    ["HTTP failure", release("2.0.0"), () => new Response("unavailable", { status: 503 })],
    ["empty metadata body", release("2.0.0"), () => new Response(null)],
    ["request abort", release("2.0.0"), () => Promise.reject(new DOMException("Timed out", "TimeoutError"))],
    ["broken metadata stream", release("2.0.0"), () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("metadata stream closed")); } }))],
  ] satisfies Array<[string, Fixture, (() => Response | Promise<Response>) | undefined]>) await t.test(name, async () => {
    const responses = new Map<string, () => Response | Promise<Response>>();
    if (response) responses.set(fixture.metadataURL, response);
    assert.equal((await checkMacUpdates({ arch: "arm64", transport: transportFor([fixture, valid], responses) }))?.manifest.version, "1.0.0");
  });
});

test("downloads publish only a complete verified installer with private permissions", async () => {
  const selected = await candidate(), directory = await mkdtemp(path.join(os.tmpdir(), "deck-installer-"));
  try {
    const chunks = [installer.subarray(0, 3), installer.subarray(3, 8), installer.subarray(8)];
    const file = await downloadMacUpdate(selected, directory, async () => new Response(new ReadableStream({
      pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); },
    })));
    assert.deepEqual(await readFile(file), installer);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [selected.manifest.filename]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bad, oversized and aborted downloads leave no partial installer or overwrite", async (t) => {
  const selected = await candidate();
  const cases: Array<[string, () => Response]> = [
    ["wrong digest", () => new Response(Buffer.alloc(installer.length))],
    ["short body", () => new Response(installer.subarray(0, 3))],
    ["oversized streamed body", () => {
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) { if (sent) controller.enqueue(Buffer.from("extra")); else { sent = true; controller.enqueue(installer); } } }));
    }],
    ["aborted stream after data", () => {
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) { if (sent) controller.error(new DOMException("Download aborted", "AbortError")); else { sent = true; controller.enqueue(installer.subarray(0, 3)); } } }));
    }],
    ["HTTP error", () => new Response("unavailable", { status: 503 })],
    ["empty response body", () => new Response(null)],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "deck-installer-failure-"));
    const existing = path.join(directory, selected.manifest.filename);
    try {
      await writeFile(existing, "previous complete download");
      await assert.rejects(downloadMacUpdate(selected, directory, async () => response()));
      assert.deepEqual(await readdir(directory), [selected.manifest.filename]);
      assert.equal(await readFile(existing, "utf8"), "previous complete download");
      await rm(existing);
      await assert.rejects(downloadMacUpdate(selected, directory, async () => response()));
      assert.deepEqual(await readdir(directory), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test("invalid download manifests are rejected before fetching or writing", async () => {
  const selected = await candidate(), directory = await mkdtemp(path.join(os.tmpdir(), "deck-installer-invalid-"));
  try {
    for (const change of [
      { filename: "../device-deck-1.0.0.pkg" }, { signing: "ad-hoc" }, { sha256: "" },
      { bytes: 0 }, { bytes: 2 * 1024 ** 3 + 1 }, { url: "https://other.invalid/installer.pkg" },
    ]) await assert.rejects(downloadMacUpdate({ manifest: { ...selected.manifest, ...change } }, directory, async () => { throw new Error("Unexpected download request"); }), /Invalid/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
