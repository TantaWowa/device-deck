import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { type InstallerTrust } from "./trust";
const manifestSchema = z
  .object({
    schema: z.literal(1),
    accountId: z.string().min(1),
    productId: z.string().min(1),
    releaseId: z.string().min(1),
    artifactId: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/),
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
    filename: z.string().regex(/^device-deck-[A-Za-z0-9.-]+\.(?:tar\.gz|pkg)$/),
    format: z.enum(["tar.gz", "pkg"]).optional(),
    mode: z.enum(["live", "test"]).optional(),
    channel: z.enum(["beta", "stable"]).optional(),
    signing: z.enum(["ad-hoc", "developer-id-notarized"]).optional(),
    minimumOS: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
    issued: z.string().datetime(),
    expires: z.string().datetime(),
  })
  .strict()
  .refine(m => !m.filename.endsWith(".pkg") || (m.format === "pkg" && m.mode && m.channel && m.signing && m.minimumOS), "Mac package metadata is incomplete")
  .refine(m => m.format !== "pkg" || m.filename.endsWith(".pkg"), "Package format does not match filename");
export type Manifest = z.infer<typeof manifestSchema>;
export function verifyManifest(
  envelope: unknown,
  trust: InstallerTrust,
  now = Date.now(),
  requireFresh = true,
) {
  const signed = z
    .object({ payload: z.string().max(100000), signature: z.string().max(200) })
    .strict()
    .parse(envelope);
  if (!/^[a-f0-9]{64}$/i.test(trust.metadataPublicKey))
    throw new Error("Release signing key is not configured");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(trust.metadataPublicKey, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.from(`device-deck-release/v1/${signed.payload}`),
      key,
      Buffer.from(signed.signature, "base64"),
    )
  )
    throw new Error("Release metadata signature is invalid");
  const manifest = manifestSchema.parse(
    JSON.parse(Buffer.from(signed.payload, "base64").toString("utf8")),
  );
  if (
    manifest.accountId !== trust.accountId ||
    manifest.productId !== trust.productId ||
    (requireFresh &&
      (Date.parse(manifest.issued) > now ||
        Date.parse(manifest.expires) <= now)) ||
    Date.parse(manifest.expires) <= Date.parse(manifest.issued) ||
    Date.parse(manifest.expires) - Date.parse(manifest.issued) > 90 * 86400000
  )
    throw new Error("Release identity or metadata lifetime is invalid");
  return manifest;
}
export function verifyArchive(bytes: Buffer, manifest: Manifest) {
  if (
    bytes.length !== manifest.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
  )
    throw new Error(
      "Downloaded archive integrity does not match its signed metadata",
    );
}
export async function download(
  manifest: Manifest,
  key?: string,
  transport: typeof fetch = fetch,
) {
  if (key !== undefined && (!key.trim() || /[\r\n]/.test(key)))
    throw new Error("Invalid download license");
  const response = await transport(
    `https://api.keygen.sh/v1/accounts/${encodeURIComponent(manifest.accountId)}/artifacts/${encodeURIComponent(manifest.artifactId)}?product=${encodeURIComponent(manifest.productId)}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(key ? { Authorization: `License ${key}` } : {}),
        Accept: "application/vnd.api+json",
        Prefer: "no-redirect",
      },
    },
  );
  if (!response.ok)
    throw new Error(`Protected download denied (${response.status})`);
  const { data, errors } = await response.json();
  if (
    errors ||
    data?.type !== "artifacts" ||
    data.id !== manifest.artifactId ||
    data.attributes?.filename !== manifest.filename ||
    data.attributes?.filesize !== manifest.bytes ||
    data.relationships?.release?.data?.id !== manifest.releaseId
  )
    throw new Error(
      "Keygen artifact identity does not match the signed release",
    );
  const url = new URL(data.links?.redirect);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname.endsWith(".amazonaws.com") ||
      url.hostname.endsWith(".keygen.sh") ||
      url.hostname ===
        "keygen-dist.c3c9112df8df715f42d1162cdce5dba1.r2.cloudflarestorage.com"
    )
  )
    throw new Error("Untrusted artifact storage redirect");
  // The storage request intentionally carries no Keygen license header.
  const file = await transport(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (!file.ok || !file.body)
    throw new Error("Artifact storage download failed");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of file.body as any) {
    length += chunk.length;
    if (length > manifest.bytes)
      throw new Error("Artifact exceeded its signed size");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  verifyArchive(bytes, manifest);
  return bytes;
}
const versionFolder = (m: Manifest) => `${m.version}-${m.arch}-${m.sha256}`;
export async function install(
  envelope: unknown,
  trust: InstallerTrust,
  licenseKey: string,
  directory: string,
  transport: typeof fetch = fetch,
) {
  const manifest = verifyManifest(envelope, trust);
  if (manifest.filename.endsWith(".pkg")) throw new Error("Use devdeck update download for Mac installers. This archive installer cannot apply a .pkg.");
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error(
      "This signed release is for another platform or architecture",
    );
  const bytes = await download(manifest, licenseKey, transport);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(directory, ".install-"));
  try {
    const archive = path.join(temporary, "release.tar.gz");
    await writeFile(archive, bytes, { mode: 0o600 });
    const run = promisify(execFile);
    const { stdout: names } = await run("/usr/bin/tar", ["-tzf", archive], {
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const name of names.trim().split("\n"))
      if (
        !name.startsWith("device-deck/") ||
        name.split("/").includes("..") ||
        /[\\\r]/.test(name)
      )
        throw new Error("Unsafe archive path");
    const { stdout: types } = await run("/usr/bin/tar", ["-tvzf", archive], {
      maxBuffer: 8 * 1024 * 1024,
    });
    if (
      types
        .trim()
        .split("\n")
        .some((line) => !/^[-d]/.test(line))
    )
      throw new Error("Archive links and special files are not permitted");
    await run("/usr/bin/tar", ["-xzf", archive, "-C", temporary]);
    const extracted = path.join(temporary, "device-deck");
    for (const file of [
      "build/devdeck.mjs",
      "build/daemon.mjs",
      "build/native/deck-camera",
      "native/apple-tv.py",
      "THIRD_PARTY_NOTICES.txt",
    ])
      if (!(await stat(path.join(extracted, file))).isFile())
        throw new Error("Release lacks a required runtime file");
    const target = path.join(directory, versionFolder(manifest));
    // Never replace a release in use by a running daemon.
    try {
      await stat(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await rename(extracted, target);
    }
    const pointer = path.join(temporary, "active.json");
    await writeFile(pointer, JSON.stringify(envelope), { mode: 0o600 });
    await rename(pointer, path.join(directory, "active.json"));
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function installedEntry(directory: string, trust: InstallerTrust) {
  const envelope = JSON.parse(
    await readFile(path.join(directory, "active.json"), "utf8"),
  );
  const manifest = verifyManifest(envelope, trust, Date.now(), false);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error("Installed release is for another platform");
  const entry = path.join(
    directory,
    versionFolder(manifest),
    "build/devdeck.mjs",
  );
  if (!(await stat(entry)).isFile())
    throw new Error("Installed runtime is missing");
  return entry;
}
