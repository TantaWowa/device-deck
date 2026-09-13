import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  download,
  verifyManifest,
  verifyArchive,
  type Manifest,
} from "./index";
import { installerTrust, type InstallerTrust } from "./trust";
import { releaseMode } from "../../licensing/src/trust";

export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9.-]+))?$/.exec(v);
    if (!match) throw new Error("Invalid release version.");
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const aa = parse(a),
    bb = parse(b);
  for (let i = 0; i < 3; i++)
    if (aa.core[i] !== bb.core[i]) return aa.core[i] > bb.core[i] ? 1 : -1;
  if (!aa.pre || !bb.pre) return aa.pre ? -1 : bb.pre ? 1 : 0;
  for (let i = 0; i < Math.max(aa.pre.length, bb.pre.length); i++) {
    const x = aa.pre[i],
      y = bb.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export type MacRelease = { manifest: Manifest; envelope: unknown };
export function currentMacOSVersion() {
  if (process.platform !== "darwin")
    throw new Error("Mac package updates require macOS.");
  const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
    encoding: "utf8",
  }).trim();
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version))
    throw new Error("Unable to determine the macOS product version.");
  return version;
}
export function supportsMacOS(minimum: string, current: string) {
  if (
    ![minimum, current].every((version) => /^\d+\.\d+(?:\.\d+)?$/.test(version))
  )
    throw new Error("Invalid macOS product version.");
  const normalize = (version: string) =>
    version.split(".").length === 2 ? `${version}.0` : version;
  return compareVersions(normalize(current), normalize(minimum)) >= 0;
}
export async function checkMacUpdates({
  key,
  channel = releaseMode === "test" ? "beta" : "stable",
  trust = installerTrust,
  mode = releaseMode,
  arch = process.arch,
  osVersion = currentMacOSVersion(),
  transport = fetch,
}: {
  key?: string;
  channel?: "beta" | "stable";
  trust?: InstallerTrust;
  mode?: "live" | "test";
  arch?: string;
  osVersion?: string;
  transport?: typeof fetch;
} = {}): Promise<MacRelease | undefined> {
  if (key !== undefined && (!key.trim() || /[\r\n]/.test(key)))
    throw new Error("Invalid download license.");
  const candidates: MacRelease[] = [];
  let cursor = "";
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({
      product: trust.productId,
      channel,
      platform: "darwin",
      arch: arch === "x64" ? "amd64" : arch,
      filetype: "pkg",
      status: "UPLOADED",
      "page[size]": "100",
      "page[cursor]": cursor,
    });
    const response = await transport(
      `https://api.keygen.sh/v1/accounts/${encodeURIComponent(trust.accountId)}/artifacts?${query}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.api+json",
          ...(key ? { Authorization: `License ${key}` } : {}),
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `Update lookup failed (${response.status}). ${mode === "test" ? "The team beta requires a Device Deck Test license." : "Try again later."}`,
      );
    const result = await response.json();
    if (!Array.isArray(result.data) || result.errors)
      throw new Error("Invalid release collection.");
    for (const artifact of result.data) {
      const envelope = artifact.attributes?.metadata?.deviceDeckManifest;
      if (!envelope) continue;
      let manifest: Manifest;
      try {
        manifest = verifyManifest(envelope, trust);
      } catch {
        continue;
      }
      if (
        manifest.format !== "pkg" ||
        manifest.mode !== mode ||
        manifest.channel !== channel ||
        manifest.arch !== arch ||
        manifest.platform !== "darwin" ||
        (mode === "live" && manifest.signing !== "developer-id-notarized")
      )
        continue;
      if (!supportsMacOS(manifest.minimumOS!, osVersion)) continue;
      if (
        artifact.type !== "artifacts" ||
        artifact.id !== manifest.artifactId ||
        artifact.attributes.filename !== manifest.filename ||
        artifact.attributes.filesize !== manifest.bytes ||
        artifact.relationships?.release?.data?.id !== manifest.releaseId
      )
        continue;
      candidates.push({ manifest, envelope });
    }
    if (
      result.data.length === 0 ||
      result.links?.next === null ||
      (!result.links?.next && result.data.length < 100)
    )
      break;
    const next = result.data.at(-1)?.id;
    if (typeof next !== "string" || !next || next === cursor)
      throw new Error("Update pagination did not advance.");
    if (page === 20)
      throw new Error("Update collection exceeds the supported page limit.");
    cursor = next;
  }
  return candidates.sort((a, b) =>
    compareVersions(b.manifest.version, a.manifest.version),
  )[0];
}
export async function downloadMacUpdate(
  release: MacRelease,
  directory: string,
  key?: string,
  transport: typeof fetch = fetch,
  trust = installerTrust,
) {
  const manifest = verifyManifest(release.envelope, trust);
  if (
    manifest.format !== "pkg" ||
    manifest.arch !== process.arch ||
    process.platform !== "darwin"
  )
    throw new Error("Installer does not match this Mac.");
  if (!supportsMacOS(manifest.minimumOS!, currentMacOSVersion()))
    throw new Error(
      `This installer requires macOS ${manifest.minimumOS} or later.`,
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, manifest.filename);
  try {
    verifyArchive(await readFile(destination), manifest);
    return destination;
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code &&
      (e as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw e;
  }
  const bytes = await download(manifest, key, transport);
  const temporary = path.join(directory, `.${randomUUID()}.download`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  // Applying a package remains explicit. No daemon, session or data is changed.
  return destination;
}
