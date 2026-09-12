import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  verifyManifest,
  verifyArchive,
  download,
  install,
  installedEntry,
  type Manifest,
} from "./index";
const pair = generateKeyPairSync("ed25519"),
  trust = {
    accountId: "account",
    productId: "product",
    metadataPublicKey: pair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex"),
  };
const bytes = Buffer.from("signed archive fixture");
function manifest(): Manifest {
  return {
    schema: 1,
    accountId: "account",
    productId: "product",
    releaseId: "release",
    artifactId: "artifact",
    version: "0.4.0",
    platform: "darwin",
    arch: process.arch as "arm64",
    filename: "device-deck-0.4.0-macos-arm64.tar.gz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    issued: new Date(Date.now() - 1000).toISOString(),
    expires: new Date(Date.now() + 86400000).toISOString(),
  };
}
function envelope(m = manifest()) {
  const payload = Buffer.from(JSON.stringify(m)).toString("base64");
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(`device-deck-release/v1/${payload}`),
      pair.privateKey,
    ).toString("base64"),
  };
}
test("installer rejects forged/wrong-product metadata, tampered archives and unsafe storage redirects", async () => {
  const m = manifest(),
    e = envelope(m);
  assert.equal(verifyManifest(e, trust).version, "0.4.0");
  assert.throws(() =>
    verifyManifest(
      { ...e, signature: Buffer.alloc(64).toString("base64") },
      trust,
    ),
  );
  assert.throws(() =>
    verifyManifest(envelope({ ...m, productId: "other" }), trust),
  );
  assert.throws(() => verifyArchive(Buffer.from("tampered"), m));
  let storage = false;
  const transport = async (url: any, init: any) => {
    if (String(url).startsWith("https://api.keygen.sh/")) {
      assert.equal(init.headers.Authorization, "License fixture-key");
      return Response.json({
        data: {
          type: "artifacts",
          id: m.artifactId,
          attributes: { filename: m.filename, filesize: m.bytes },
          relationships: {
            product: { data: { id: m.productId } },
            release: { data: { id: m.releaseId } },
          },
          links: { redirect: "https://fixture.s3.amazonaws.com/archive" },
        },
      });
    }
    storage = true;
    assert.equal(init.headers, undefined);
    return new Response(bytes);
  };
  assert.deepEqual(
    await download(m, "fixture-key", transport as typeof fetch),
    bytes,
  );
  assert.equal(storage, true);
  await assert.rejects(
    download(m, "fixture-key", (async () =>
      Response.json({
        data: {
          type: "artifacts",
          id: m.artifactId,
          attributes: { filename: m.filename, filesize: m.bytes },
          relationships: {
            product: { data: { id: m.productId } },
            release: { data: { id: m.releaseId } },
          },
          links: { redirect: "http://127.0.0.1/private" },
        },
      })) as typeof fetch),
    /Untrusted/,
  );
});
test("expired download metadata denies a new install but does not expire an existing installed app", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-installer-"));
  try {
    const m = manifest();
    m.issued = new Date(Date.now() - 2 * 86400000).toISOString();
    m.expires = new Date(Date.now() - 86400000).toISOString();
    const e = envelope(m);
    let fetched = false;
    await assert.rejects(
      install(e, trust, "fixture-key", directory, (async () => {
        fetched = true;
        throw new Error();
      }) as typeof fetch),
      /lifetime/,
    );
    assert.equal(fetched, false);
    const folder = path.join(
      directory,
      `${m.version}-${m.arch}-${m.sha256}`,
      "build",
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "devdeck.mjs"),
      "// previously installed test runtime",
    );
    await writeFile(path.join(directory, "active.json"), JSON.stringify(e));
    assert.equal(
      await installedEntry(directory, trust),
      path.join(folder, "devdeck.mjs"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
