import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkMacUpdates,
  compareVersions,
  downloadMacUpdate,
} from "./mac-update";
import { verifyManifest, type Manifest } from "./index";
const pair = generateKeyPairSync("ed25519");
const trust = {
  accountId: "test-account",
  productId: "test-product",
  metadataPublicKey: pair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("hex"),
};
const bytes = Buffer.from("test installer bytes");
function release(changes: Partial<Manifest> = {}) {
  const manifest: Manifest = {
    schema: 1,
    accountId: trust.accountId,
    productId: trust.productId,
    releaseId: "release-id",
    artifactId: "artifact-id",
    version: "0.5.0-beta.2",
    platform: "darwin",
    arch: process.arch as "arm64" | "x64",
    filename: "device-deck-0.5.0-beta.2-macos-arm64-test-team.pkg",
    format: "pkg",
    mode: "test",
    channel: "beta",
    signing: "ad-hoc",
    minimumOS: "14.0",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    issued: new Date(Date.now() - 1000).toISOString(),
    expires: new Date(Date.now() + 86400000).toISOString(),
    ...changes,
  };
  const payload = Buffer.from(JSON.stringify(manifest)).toString("base64");
  const envelope = {
    payload,
    signature: sign(
      null,
      Buffer.from(`device-deck-release/v1/${payload}`),
      pair.privateKey,
    ).toString("base64"),
  };
  return { manifest, envelope };
}
function artifact(r = release()) {
  return {
    type: "artifacts",
    id: r.manifest.artifactId,
    attributes: {
      filename: r.manifest.filename,
      filesize: r.manifest.bytes,
      metadata: { deviceDeckManifest: r.envelope },
    },
    relationships: { release: { data: { id: r.manifest.releaseId } } },
    links: { redirect: "https://fixtures.s3.amazonaws.com/device-deck.pkg" },
  };
}
test("update selection rejects cross-product/mode/channel, forged, stale and unsigned live manifests", async () => {
  const valid = artifact();
  const forged = artifact();
  forged.attributes.metadata.deviceDeckManifest.signature =
    Buffer.alloc(64).toString("base64");
  const candidates = [
    artifact(release({ version: "9.0.0", productId: "other" })),
    artifact(release({ version: "8.0.0", mode: "live" })),
    artifact(release({ version: "7.0.0", channel: "stable" })),
    artifact(
      release({
        version: "6.0.0",
        issued: new Date(Date.now() - 86400000).toISOString(),
        expires: new Date(Date.now() - 1000).toISOString(),
      }),
    ),
    forged,
    valid,
  ];
  const result = await checkMacUpdates({
    trust,
    osVersion: "14.0",
    mode: "test",
    key: "fixture",
    channel: "beta",
    transport: (async (url, init) => {
      const query = new URL(String(url)).searchParams;
      assert.equal(query.get("product"), trust.productId);
      assert.equal(query.get("filetype"), "pkg");
      assert.equal(query.get("status"), "UPLOADED");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "License fixture",
      );
      return Response.json({ data: candidates });
    }) as typeof fetch,
  });
  assert.equal(result?.manifest.version, "0.5.0-beta.2");
  const live = release({ mode: "live", channel: "stable" });
  assert.equal(
    await checkMacUpdates({
      trust,
      osVersion: "14.0",
      mode: "live",
      channel: "stable",
      transport: (async () =>
        Response.json({ data: [artifact(live)] })) as typeof fetch,
    }),
    undefined,
  );
  assert.throws(
    () => verifyManifest(release({ format: undefined }).envelope, trust),
    /incomplete/,
  );
});
test("versions order beta numerically and put stable after prereleases", () => {
  for (const [a, b] of [
    ["0.5.0-beta.10", "0.5.0-beta.2"],
    ["0.5.0", "0.5.0-beta.99"],
    ["1.0.0", "0.9.99"],
  ]) {
    assert.equal(compareVersions(a, b), 1);
    assert.equal(compareVersions(b, a), -1);
  }
  assert.equal(compareVersions("0.5.0-beta.2", "0.5.0-beta.2"), 0);
});
test(
  "Mac update stages verified bytes, keeps credentials off storage, and never applies an installer",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "deck-update-"));
    try {
      let calls = 0;
      const transport = (async (url, init) => {
        calls++;
        if (String(url).includes("api.keygen.sh")) {
          assert.equal(
            (init?.headers as Record<string, string>).Authorization,
            "License fixture",
          );
          return Response.json({ data: artifact() });
        }
        assert.equal(init?.headers, undefined);
        return new Response(bytes);
      }) as typeof fetch;
      const staged = await downloadMacUpdate(
        release(),
        directory,
        "fixture",
        transport,
        trust,
      );
      assert.deepEqual(await readFile(staged), bytes);
      assert.equal(calls, 2);
      await downloadMacUpdate(
        release(),
        directory,
        "fixture",
        transport,
        trust,
      );
      assert.equal(calls, 2);
      assert.equal((await readdir(directory)).length, 1);
      await assert.rejects(
        downloadMacUpdate(
          release({
            sha256: "0".repeat(64),
            filename: "device-deck-corrupt.pkg",
          }),
          directory,
          "fixture",
          (async (url) =>
            String(url).includes("api.keygen.sh")
              ? Response.json({
                  data: artifact(
                    release({
                      sha256: "0".repeat(64),
                      filename: "device-deck-corrupt.pkg",
                    }),
                  ),
                })
              : new Response(bytes)) as typeof fetch,
          trust,
        ),
        /integrity/,
      );
      assert.equal((await readdir(directory)).length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test("updates paginate by cursor and offer the newest package compatible with the actual macOS product version", async () => {
  const incompatible = release({
    minimumOS: "15.0",
    version: "1.0.0-beta.1",
    artifactId: "newer-artifact",
  });
  const compatible = release({
    minimumOS: "14.0.1",
    version: "0.6.0-beta.1",
    artifactId: "compatible-artifact",
  });
  let calls = 0;
  const transport: typeof fetch = async (input) => {
    const query = new URL(String(input)).searchParams;
    assert.equal(query.has("page[number]"), false);
    if (++calls === 1) {
      assert.equal(query.get("page[cursor]"), "");
      return Response.json({
        data: [artifact(incompatible)],
        links: { next: "/next-page" },
      });
    }
    assert.equal(query.get("page[cursor]"), "newer-artifact");
    return Response.json({
      data: [artifact(compatible)],
      links: { next: null },
    });
  };
  const result = await checkMacUpdates({
    trust,
    mode: "test",
    channel: "beta",
    osVersion: "14.2",
    transport,
  });
  assert.equal(result?.manifest.artifactId, "compatible-artifact");
  assert.equal(calls, 2);
  assert.equal(
    await checkMacUpdates({
      trust,
      mode: "test",
      channel: "beta",
      osVersion: "14.0",
      transport: async () => Response.json({ data: [artifact(compatible)] }),
    }),
    undefined,
  );
});
test(
  "download refuses a valid signed package for a newer macOS before touching disk or network",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "deck-os-update-"));
    try {
      await assert.rejects(
        downloadMacUpdate(
          release({ minimumOS: "99.0" }),
          directory,
          undefined,
          async () => {
            assert.fail("Must not download an incompatible package");
          },
          trust,
        ),
        /requires macOS 99.0/,
      );
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
