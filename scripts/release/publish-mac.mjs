import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import {
  readFile,
  writeFile,
  stat,
  mkdtemp,
  rm,
  readdir,
} from "node:fs/promises";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { Keygen, relation } from "./keygen.mjs";

const execute = promisify(execFile);
const managedBy = "device-deck-release-tools";
const maximumBytes = 2 * 1024 * 1024 * 1024;
const packageName = /^device-deck-[A-Za-z0-9.-]+\.pkg$/;
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const same = (a, b, description) => {
  if (a !== b) throw new Error(`${description} does not match.`);
};
export async function checksums(file) {
  const sha = createHash("sha256"),
    md5 = createHash("md5");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > maximumBytes)
      throw new Error("Package exceeds the 2 GB release limit.");
    sha.update(chunk);
    md5.update(chunk);
  }
  // MD5 is only the S3 transport checksum; signed SHA-256 is the trust check.
  return { bytes, sha256: sha.digest("hex"), md5: md5.digest("base64") };
}
export function validateMetadata(metadata, trust, release) {
  if (
    metadata.schemaVersion !== 1 ||
    metadata.application !== "com.tantawowa.device-deck"
  )
    throw new Error("Not a Device Deck package metadata file.");
  if (!["arm64", "x64"].includes(metadata.arch))
    throw new Error("Unsupported package architecture.");
  same(metadata.mode, release ? "live" : "test", "Package licensing mode");
  same(
    metadata.channel,
    release ? "stable" : "team",
    "Package distribution channel",
  );
  same(metadata.build?.mode, metadata.mode, "Embedded build mode");
  same(metadata.build?.arch, metadata.arch, "Embedded build architecture");
  same(metadata.build?.version, metadata.version, "Embedded build version");
  same(
    metadata.build?.licenseProductId,
    trust.productId,
    "Embedded license product",
  );
  if (
    !(release ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+-beta\.\d+$/).test(
      metadata.version,
    )
  )
    throw new Error(
      release
        ? "Public releases require a stable semantic version."
        : "Team releases require a beta version such as 0.5.0-beta.1.",
    );
  if (
    !packageName.test(metadata.file || "") ||
    path.basename(metadata.file) !== metadata.file
  )
    throw new Error("Unsafe package filename.");
  const expectedName = `device-deck-${metadata.version}-macos-${metadata.arch}-${metadata.mode}${release ? "" : "-team"}.pkg`;
  same(metadata.file, expectedName, "Package filename identity");
  if (
    !/^[a-f0-9]{64}$/.test(metadata.sha256 || "") ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes <= 0 ||
    metadata.bytes > maximumBytes
  )
    throw new Error("Invalid package checksum or size.");
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(metadata.minimumOS || ""))
    throw new Error("Invalid minimum macOS version.");
  if (!["ad-hoc", "developer-id-notarized"].includes(metadata.signing))
    throw new Error("Unknown package signing mode.");
  if (release && metadata.signing !== "developer-id-notarized")
    throw new Error("Public releases require a signed and notarized package.");
}
async function findApps(directory, depth = 0) {
  if (depth > 10) return [];
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name);
    if (entry.name === "Device Deck.app") results.push(file);
    else results.push(...(await findApps(file, depth + 1)));
  }
  return results;
}
/** Inspect the actual package payload without running the installer or its scripts. */
export async function inspectPackage(
  file,
  metadata,
  { release = false, run = execute } = {},
) {
  if (release) {
    const signature = await run("/usr/sbin/pkgutil", [
      "--check-signature",
      file,
    ]);
    if (!/Developer ID Installer/.test(String(signature.stdout)))
      throw new Error("Package lacks a Developer ID Installer signature.");
    await run("/usr/bin/xcrun", ["stapler", "validate", file]);
    await run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "install",
      "--verbose=2",
      file,
    ]);
  }
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "deck-publish-inspect-"),
  );
  try {
    const expanded = path.join(temporary, "expanded");
    await run("/usr/sbin/pkgutil", ["--expand-full", file, expanded], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const apps = await findApps(expanded);
    if (apps.length !== 1)
      throw new Error("Package must contain exactly one Device Deck.app.");
    const app = apps[0],
      resources = path.join(app, "Contents/Resources");
    const embedded = await json(path.join(resources, "distribution.json"));
    for (const field of [
      "schemaVersion",
      "application",
      "version",
      "arch",
      "mode",
      "minimumOS",
      "channel",
      "signing",
    ])
      same(embedded[field], metadata[field], `Package payload ${field}`);
    for (const field of [
      "version",
      "arch",
      "mode",
      "licenseProductId",
      "commit",
    ])
      same(
        embedded.build?.[field],
        metadata.build?.[field],
        `Package build ${field}`,
      );
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    if (release) {
      const signature = await run("/usr/bin/codesign", [
        "--display",
        "--verbose=4",
        app,
      ]);
      if (!/Authority=Developer ID Application/.test(String(signature.stderr)))
        throw new Error(
          "Application lacks a Developer ID Application signature.",
        );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export function signManifest(manifest, privateKey) {
  const payload = Buffer.from(JSON.stringify(manifest)).toString("base64");
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(`device-deck-release/v1/${payload}`),
      privateKey,
    ).toString("base64"),
  };
}
export async function verifyCheckout(plan, run = execute) {
  const { stdout: dirty } = await run("/usr/bin/git", [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (String(dirty).trim())
    throw new Error(
      "Commit the complete source before publishing. The working tree must be clean.",
    );
  const { stdout: revision } = await run("/usr/bin/git", ["rev-parse", "HEAD"]);
  for (const item of plan.artifacts)
    same(
      item.metadata.build?.commit,
      String(revision).trim(),
      "Package build commit and current HEAD",
    );
}
export function verifyEnvelope(envelope, publicKey) {
  if (
    !envelope ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string" ||
    JSON.stringify(envelope).length > 4000
  )
    throw new Error("Missing or oversized published manifest.");
  if (
    !verify(
      null,
      Buffer.from(`device-deck-release/v1/${envelope.payload}`),
      publicKey,
      Buffer.from(envelope.signature, "base64"),
    )
  )
    throw new Error("Published manifest signature is invalid.");
  return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
}
export function storageUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname.endsWith(".amazonaws.com") ||
      url.hostname ===
        "keygen-dist.c3c9112df8df715f42d1162cdce5dba1.r2.cloudflarestorage.com"
    )
  )
    throw new Error("Untrusted Keygen upload redirect.");
  return url;
}
export async function prepare(
  metadataFiles,
  { release = false, config, inspect = inspectPackage } = {},
) {
  if (!metadataFiles.length)
    throw new Error("Supply at least one --metadata package.json.");
  const trust = config[release ? "live" : "test"];
  if (!trust?.accountId || !trust?.productId)
    throw new Error("Run Keygen provisioning first.");
  const artifacts = [];
  for (const metadataFile of metadataFiles) {
    const metadata = await json(metadataFile);
    validateMetadata(metadata, trust, release);
    const file = path.resolve(path.dirname(metadataFile), metadata.file);
    if (!(await stat(file)).isFile())
      throw new Error("Package is not a regular file.");
    const measured = await checksums(file);
    same(measured.bytes, metadata.bytes, "Package size");
    same(measured.sha256, metadata.sha256, "Package SHA-256");
    await inspect(file, metadata, { release });
    if (artifacts.length)
      same(
        metadata.version,
        artifacts[0].metadata.version,
        "Release version across architectures",
      );
    if (artifacts.some((a) => a.metadata.arch === metadata.arch))
      throw new Error("Duplicate release architecture.");
    artifacts.push({ file, metadata, md5: measured.md5 });
  }
  return {
    trust,
    release,
    channel: release ? "stable" : "beta",
    version: artifacts[0].metadata.version,
    artifacts,
  };
}
const publicKeyFromHex = (hex) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(hex, "hex"),
    ]),
    type: "spki",
    format: "der",
  });
export async function publish(
  plan,
  {
    client,
    privateKey,
    publicKeyHex,
    transport = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    log = console.log,
  } = {},
) {
  same(client.accountId, plan.trust.accountId, "Operator account");
  if (!/^[a-f0-9]{64}$/i.test(publicKeyHex || ""))
    throw new Error("Invalid release public key.");
  const publicKey = publicKeyFromHex(publicKeyHex);
  same(
    createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex"),
    publicKeyHex.toLowerCase(),
    "Release signing key",
  );
  const product = (await client.request(`/products/${plan.trust.productId}`))
    .data;
  same(product.id, plan.trust.productId, "Keygen product");
  same(
    product.attributes?.metadata?.deviceDeckMode,
    plan.trust.mode,
    "Keygen product mode",
  );
  same(
    product.attributes?.metadata?.managedBy,
    managedBy,
    "Keygen product manager",
  );
  same(
    product.attributes?.distributionStrategy,
    plan.release ? "OPEN" : "LICENSED",
    "Keygen distribution strategy",
  );
  const matches = (
    await client.list(
      `/releases?product=${encodeURIComponent(plan.trust.productId)}`,
    )
  ).filter((r) => r.attributes.version === plan.version);
  if (matches.length > 1) throw new Error("Ambiguous release version.");
  let release = matches[0];
  if (release) {
    same(
      release.relationships?.product?.data?.id,
      plan.trust.productId,
      "Release product",
    );
    same(release.attributes.channel, plan.channel, "Release channel");
    same(release.attributes.metadata?.managedBy, managedBy, "Release manager");
    if (!["DRAFT", "PUBLISHED"].includes(release.attributes.status))
      throw new Error("Refusing to republish a yanked release.");
  } else
    release = await client.create(
      "releases",
      {
        version: plan.version,
        name: `Device Deck ${plan.version}`,
        channel: plan.channel,
        status: "DRAFT",
        metadata: { managedBy, deviceDeckMode: plan.trust.mode },
      },
      { product: relation("products", plan.trust.productId) },
    );
  const existing = await client.list(`/releases/${release.id}/artifacts`);
  const manifests = [];
  for (const item of plan.artifacts) {
    const m = item.metadata,
      found = existing.find((a) => a.attributes.filename === m.file);
    let artifact = found,
      envelope;
    if (found) {
      same(
        found.relationships?.release?.data?.id,
        release.id,
        "Artifact release",
      );
      same(found.attributes.filesize, m.bytes, "Existing artifact size");
      same(found.attributes.checksum, m.sha256, "Existing artifact checksum");
      if (found.attributes.status !== "UPLOADED")
        throw new Error(
          "A prior artifact upload is still pending or failed. Retry after Keygen finishes processing; if upload failed, use a new beta version.",
        );
      envelope = found.attributes.metadata?.deviceDeckManifest;
      const verified = verifyEnvelope(envelope, publicKey);
      for (const [field, value] of Object.entries({
        artifactId: found.id,
        releaseId: release.id,
        accountId: plan.trust.accountId,
        productId: plan.trust.productId,
        version: m.version,
        arch: m.arch,
        mode: m.mode,
        sha256: m.sha256,
        bytes: m.bytes,
        filename: m.file,
        channel: plan.channel,
        signing: m.signing,
        format: "pkg",
      }))
        same(verified[field], value, `Existing manifest ${field}`);
      if (
        !Number.isFinite(Date.parse(verified.issued)) ||
        !Number.isFinite(Date.parse(verified.expires)) ||
        Date.parse(verified.issued) > now() ||
        Date.parse(verified.expires) <= now() ||
        Date.parse(verified.expires) - Date.parse(verified.issued) >
          90 * 86400000
      )
        throw new Error(
          "The existing signed manifest expired. Publish a new version.",
        );
    } else {
      if (release.attributes.status === "PUBLISHED")
        throw new Error(
          "Published releases are immutable. Publish all architectures together or use a new version.",
        );
      artifact = (
        await client.request("/artifacts", {
          method: "POST",
          headers: { Prefer: "no-redirect" },
          body: {
            data: {
              type: "artifacts",
              attributes: {
                filename: m.file,
                filesize: m.bytes,
                filetype: "pkg",
                platform: "darwin",
                arch: m.arch === "x64" ? "amd64" : "arm64",
                checksum: m.sha256,
              },
              relationships: { release: relation("releases", release.id) },
            },
          },
        })
      ).data;
      if (
        !artifact?.id ||
        artifact.relationships?.release?.data?.id !== release.id
      )
        throw new Error("Keygen returned an unexpected artifact identity.");
      const upload = storageUrl(artifact.links?.redirect);
      const issued = new Date(now()).toISOString();
      envelope = signManifest(
        {
          schema: 1,
          accountId: plan.trust.accountId,
          productId: plan.trust.productId,
          releaseId: release.id,
          artifactId: artifact.id,
          version: m.version,
          platform: "darwin",
          arch: m.arch,
          filename: m.file,
          sha256: m.sha256,
          bytes: m.bytes,
          issued,
          expires: new Date(Date.parse(issued) + 89 * 86400000).toISOString(),
          format: "pkg",
          mode: m.mode,
          channel: plan.channel,
          signing: m.signing,
          minimumOS: m.minimumOS,
        },
        privateKey,
      );
      if (JSON.stringify(envelope).length > 4000)
        throw new Error("Release envelope exceeds metadata limit.");
      await client.request(`/artifacts/${artifact.id}`, {
        method: "PATCH",
        body: {
          data: {
            type: "artifacts",
            id: artifact.id,
            attributes: {
              metadata: { deviceDeckManifest: envelope, managedBy },
            },
          },
        },
      });
      log(`Uploading ${m.file} (${m.bytes} bytes)…`);
      // Never forward an admin credential to storage. Content-MD5 catches file changes since validation.
      const response = await transport(upload, {
        method: "PUT",
        redirect: "error",
        headers: { "Content-Length": String(m.bytes), "Content-MD5": item.md5 },
        body: createReadStream(item.file),
        duplex: "half",
        signal: AbortSignal.timeout(600000),
      });
      if (!response.ok)
        throw new Error(
          `Artifact storage upload failed (${response.status}); release remains a draft.`,
        );
      let uploaded = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const status = (
          await client.request(`/artifacts/${artifact.id}`, {
            headers: { Prefer: "no-redirect" },
          })
        ).data;
        if (status?.attributes?.status === "UPLOADED") {
          same(status.attributes.filesize, m.bytes, "Uploaded artifact size");
          same(
            status.attributes.checksum,
            m.sha256,
            "Uploaded artifact checksum",
          );
          uploaded = true;
          break;
        }
        if (status?.attributes?.status === "FAILED")
          throw new Error(
            "Keygen reported a failed upload; release remains a draft.",
          );
        if (attempt % 5 === 0)
          log(`Waiting for Keygen to finish processing ${m.file}…`);
        await sleep(3000);
      }
      if (!uploaded)
        throw new Error(
          "Keygen is still processing the upload. Rerun this command after it finishes; the release remains a draft.",
        );
    }
    await writeFile(
      item.file.replace(/\.pkg$/, ".manifest.json"),
      JSON.stringify(envelope, null, 2) + "\n",
    );
    manifests.push({ file: m.file, artifactId: artifact.id, sha256: m.sha256 });
  }
  if (release.attributes.status !== "PUBLISHED") {
    const published = (
      await client.request(`/releases/${release.id}/actions/publish`, {
        method: "POST",
      })
    ).data;
    same(published.attributes.status, "PUBLISHED", "Published release status");
  }
  return {
    releaseId: release.id,
    version: plan.version,
    mode: plan.trust.mode,
    channel: plan.channel,
    artifacts: manifests,
  };
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      metadata: { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      release: { type: "boolean", default: false },
      "signing-key": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/release/publish-mac.mjs --metadata work/distribution/PACKAGE.json [--metadata SECOND_ARCH.json] [--apply] [--release]\nDefault: validate and preview only. Team packages must use TEST licensing and beta versions. --release requires a live, signed, notarized stable package.",
    );
    return;
  }
  const config = await json("config/releases/keygen.json");
  const plan = await prepare(values.metadata || [], {
    release: values.release,
    config,
  });
  console.log(
    JSON.stringify(
      {
        apply: values.apply,
        mode: plan.trust.mode,
        productId: plan.trust.productId,
        version: plan.version,
        channel: plan.channel,
        artifacts: plan.artifacts.map((a) => ({
          file: a.metadata.file,
          bytes: a.metadata.bytes,
          sha256: a.metadata.sha256,
        })),
      },
      null,
      2,
    ),
  );
  if (!values.apply) return;
  await verifyCheckout(plan);
  const privateKey = createPrivateKey(
    await readFile(
      values["signing-key"] ||
        process.env.DEVICE_DECK_RELEASE_SIGNING_KEY_FILE ||
        "work/release-secrets/release-signing.pem",
    ),
  );
  const publicKeyHex = (await json("config/releases/distribution.json"))
    .publicKey;
  const client = new Keygen();
  console.log(
    JSON.stringify(
      await publish(plan, { client, privateKey, publicKeyHex }),
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
