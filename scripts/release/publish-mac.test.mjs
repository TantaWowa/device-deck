import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { generateKeyPairSync, createHash, verify } from "node:crypto";
import {
  validateMetadata,
  prepare,
  publish,
  checksums,
  storageUrl,
  inspectPackage,
  verifyCheckout,
} from "./publish-mac.mjs";
import { Keygen } from "./keygen.mjs";
const trust = { mode: "test", accountId: "account", productId: "test-product" };
const config = {
  test: trust,
  live: { ...trust, mode: "live", productId: "live-product" },
};
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-publish-test-"));
  const data = Buffer.from("test-only installer bytes");
  const m = {
    schemaVersion: 1,
    application: "com.tantawowa.device-deck",
    version: "0.5.0-beta.1",
    arch: "arm64",
    mode: "test",
    minimumOS: "14.0",
    channel: "team",
    signing: "ad-hoc",
    build: {
      schema: 1,
      version: "0.5.0-beta.1",
      mode: "test",
      arch: "arm64",
      licenseProductId: trust.productId,
    },
    file: "device-deck-0.5.0-beta.1-macos-arm64-test-team.pkg",
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const file = path.join(directory, m.file),
    metadata = path.join(directory, "package.json");
  await writeFile(file, data);
  await writeFile(metadata, JSON.stringify(m));
  const keypair = generateKeyPairSync("ed25519");
  const publicKeyHex = keypair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("hex");
  const plan = await prepare([metadata], { config, inspect: async () => {} });
  let release;
  const artifacts = [],
    calls = [];
  let storageFailure = false,
    waiting = false;
  const client = {
    accountId: trust.accountId,
    list: async (route) =>
      route.startsWith("/releases?") ? (release ? [release] : []) : artifacts,
    create: async (type, attributes, relationships) => {
      calls.push({ type, method: "POST" });
      release = { id: "release-1", type, attributes, relationships };
      return release;
    },
    request: async (route, options = {}) => {
      calls.push({ route, ...options });
      if (route.startsWith("/products/"))
        return {
          data: {
            id: trust.productId,
            attributes: {
              distributionStrategy: "LICENSED",
              metadata: {
                managedBy: "device-deck-release-tools",
                deviceDeckMode: "test",
              },
            },
          },
        };
      if (route === "/artifacts" && options.method === "POST") {
        const a = {
          ...options.body.data,
          id: "artifact-1",
          attributes: { ...options.body.data.attributes, status: "WAITING" },
          links: {
            redirect:
              "https://keygen-dist.s3.us-east-2.amazonaws.com/test?upload-secret",
          },
        };
        artifacts.push(a);
        return { data: a };
      }
      if (route.endsWith("/actions/publish")) {
        release.attributes.status = "PUBLISHED";
        return { data: release };
      }
      const a = artifacts.find((a) => route === `/artifacts/${a.id}`);
      if (a) {
        if (options.method === "PATCH")
          Object.assign(a.attributes, options.body.data.attributes);
        return { data: a };
      }
      throw new Error(`Unexpected mock request ${route}`);
    },
  };
  const transport = async (url, options) => {
    calls.push({ storage: true, url, ...options });
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "error");
    const parts = [];
    for await (const part of options.body) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), data);
    sameChecksum(
      options.headers["Content-MD5"],
      createHash("md5").update(data).digest("base64"),
    );
    if (!waiting && !storageFailure)
      artifacts[0].attributes.status = "UPLOADED";
    return new Response("", { status: storageFailure ? 503 : 200 });
  };
  return {
    directory,
    file,
    metadata,
    m,
    data,
    plan,
    keypair,
    publicKeyHex,
    client,
    artifacts,
    calls,
    transport,
    setStorageFailure: () => (storageFailure = true),
    setWaiting: () => (waiting = true),
    getRelease: () => release,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
const sameChecksum = (a, b) => assert.equal(a, b);
test("dry-run preparation validates package hash and identity before any provider interaction", async () => {
  const f = await fixture();
  try {
    assert.equal(f.plan.channel, "beta");
    assert.equal(f.calls.length, 0);
    await writeFile(f.file, Buffer.from("tampered"));
    await assert.rejects(
      prepare([f.metadata], { config, inspect: async () => {} }),
      /Package size|SHA-256/,
    );
    for (const change of [
      { mode: "live" },
      { arch: "x86" },
      { file: "../escape.pkg" },
      { version: "0.5.0" },
      { bytes: 0 },
      { build: { ...f.m.build, licenseProductId: "other" } },
    ])
      assert.throws(() =>
        validateMetadata({ ...f.m, ...change }, trust, false),
      );
    assert.throws(() =>
      validateMetadata(
        { ...f.m, mode: "live", channel: "stable" },
        config.live,
        true,
      ),
    );
  } finally {
    await f.cleanup();
  }
});
test("publishing signs the exact artifact identity, uploads without Keygen auth, waits and publishes last", async () => {
  const f = await fixture();
  try {
    const result = await publish(f.plan, {
      client: f.client,
      privateKey: f.keypair.privateKey,
      publicKeyHex: f.publicKeyHex,
      transport: f.transport,
      sleep: async () => {},
      log: () => {},
    });
    assert.equal(result.mode, "test");
    assert.equal(result.channel, "beta");
    assert.equal(f.getRelease().attributes.status, "PUBLISHED");
    const envelope = f.artifacts[0].attributes.metadata.deviceDeckManifest;
    assert(
      verify(
        null,
        Buffer.from(`device-deck-release/v1/${envelope.payload}`),
        f.keypair.publicKey,
        Buffer.from(envelope.signature, "base64"),
      ),
    );
    const m = JSON.parse(Buffer.from(envelope.payload, "base64"));
    assert.equal(m.artifactId, "artifact-1");
    assert.equal(m.productId, trust.productId);
    assert.equal(m.signing, "ad-hoc");
    assert.equal(m.format, "pkg");
    assert.equal(m.sha256, f.m.sha256);
    assert.deepEqual(
      JSON.parse(
        await readFile(f.file.replace(".pkg", ".manifest.json"), "utf8"),
      ),
      envelope,
    );
    assert.match(f.calls.at(-1).route, /actions\/publish$/);
    const count = f.calls.filter((c) => c.method && c.method !== "GET").length;
    await publish(f.plan, {
      client: f.client,
      privateKey: f.keypair.privateKey,
      publicKeyHex: f.publicKeyHex,
      transport: f.transport,
      log: () => {},
    });
    assert.equal(
      f.calls.filter((c) => c.method && c.method !== "GET").length,
      count,
      "repeat invocation is read-only for an identical published artifact",
    );
  } finally {
    await f.cleanup();
  }
});
test("upload failure leaves a draft; mismatched signing key or product strategy never creates a release", async () => {
  const f = await fixture();
  try {
    const other = generateKeyPairSync("ed25519");
    await assert.rejects(
      publish(f.plan, {
        client: f.client,
        privateKey: other.privateKey,
        publicKeyHex: f.publicKeyHex,
      }),
      /signing key/,
    );
    assert.equal(f.calls.length, 0);
    f.setStorageFailure();
    await assert.rejects(
      publish(f.plan, {
        client: f.client,
        privateKey: f.keypair.privateKey,
        publicKeyHex: f.publicKeyHex,
        transport: f.transport,
        log: () => {},
      }),
      /upload failed/,
    );
    assert.equal(f.getRelease().attributes.status, "DRAFT");
    assert(!f.calls.some((c) => c.route?.endsWith("/actions/publish")));
  } finally {
    await f.cleanup();
  }
});
test("unsafe upload redirects are rejected without sending package data", () => {
  for (const url of [
    "http://keygen-dist.s3.amazonaws.com/a",
    "https://api.keygen.sh/a",
    "https://evil.test/a",
    "https://bucket.amazonaws.com.evil.test/a",
    "https://user:password@bucket.amazonaws.com/a",
    "https://bucket.amazonaws.com:8443/a",
  ])
    assert.throws(() => storageUrl(url), /Untrusted/);
  assert.equal(
    storageUrl("https://keygen-dist.s3.us-east-2.amazonaws.com/a").protocol,
    "https:",
  );
});
test("public release revalidates package signature before invoking notarization and never trusts metadata alone", async () => {
  const f = await fixture();
  const commands = [];
  try {
    await assert.rejects(
      inspectPackage(f.file, f.m, {
        release: true,
        run: async (command, args) => {
          commands.push([command, args]);
          return { stdout: "Package is unsigned", stderr: "" };
        },
      }),
      /Developer ID Installer/,
    );
    assert.equal(commands.length, 1);
  } finally {
    await f.cleanup();
  }
});
test("Keygen no-redirect hint is retained, credentials never follow redirects, and extra headers cannot replace the credential", async () => {
  let options;
  const c = new Keygen({
    accountId: "fixture-account",
    token: "operator-secret",
    transport: async (_url, o) => {
      options = o;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    },
  });
  await c.request("/artifacts", {
    method: "POST",
    headers: { Prefer: "no-redirect", Authorization: "attacker" },
    body: { data: {} },
  });
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.Prefer, "no-redirect");
  assert.equal(options.headers.Authorization, "Bearer operator-secret");
});

test("publishing requires a clean checkout and the exact packaged commit", async () => {
  const plan = {
    artifacts: [{ metadata: { build: { commit: "commit-one" } } }],
  };
  await assert.rejects(
    verifyCheckout(plan, async () => ({ stdout: " M tracked-source.ts" })),
    /working tree must be clean/,
  );
  await assert.rejects(
    verifyCheckout(plan, async (_command, args) => ({
      stdout: args[0] === "status" ? "" : "commit-two\n",
    })),
    /build commit/,
  );
  await verifyCheckout(plan, async (_command, args) => ({
    stdout: args[0] === "status" ? "" : "commit-one\n",
  }));
});

test("pending upload remains draft and resumes after Keygen marks the same artifact uploaded", async () => {
  const f = await fixture();
  try {
    f.setWaiting();
    const options = {
      client: f.client,
      privateKey: f.keypair.privateKey,
      publicKeyHex: f.publicKeyHex,
      transport: f.transport,
      sleep: async () => {},
      log: () => {},
    };
    await assert.rejects(publish(f.plan, options), /still processing/);
    assert.equal(f.getRelease().attributes.status, "DRAFT");
    f.artifacts[0].attributes.status = "UPLOADED";
    await publish(f.plan, options);
    assert.equal(f.getRelease().attributes.status, "PUBLISHED");
    assert.equal(
      f.calls.filter((c) => c.storage).length,
      1,
      "resume does not repeat the upload",
    );
  } finally {
    await f.cleanup();
  }
});

test("team product must remain license-gated before any release mutation", async () => {
  const f = await fixture();
  try {
    const request = f.client.request;
    f.client.request = async (route, options) => {
      const result = await request(route, options);
      if (route.startsWith("/products/"))
        result.data.attributes.distributionStrategy = "OPEN";
      return result;
    };
    await assert.rejects(
      publish(f.plan, {
        client: f.client,
        privateKey: f.keypair.privateKey,
        publicKeyHex: f.publicKeyHex,
      }),
      /distribution strategy/,
    );
    assert.equal(f.getRelease(), undefined);
  } finally {
    await f.cleanup();
  }
});
