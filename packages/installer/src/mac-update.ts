import { mkdir, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
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

export type MacRelease = { manifest: { version: string; filename: string; url: string; sha256: string; bytes: number; signing: string } };
const repository = "https://api.github.com/repos/TantaWowa/device-deck";
function assetURL(value: unknown, version: string, filename: string) {
  try {
    const url = new URL(String(value));
    return url.origin === "https://github.com" && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === `/TantaWowa/device-deck/releases/download/v${version}/${filename}` ? url.href : undefined;
  } catch { return undefined; }
}
export async function checkMacUpdates({ channel = "beta", arch = process.arch, transport = fetch }: { channel?: "beta" | "stable"; arch?: string; transport?: typeof fetch } = {}): Promise<MacRelease | undefined> {
  const response = await transport(`${repository}/releases?per_page=100`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error("Invalid GitHub release collection.");
  const candidates: (MacRelease & { metadataURL: string; metadataAsset: { size: number; digest: string } })[] = [];
  for (const release of releases) {
    if (!release || typeof release !== "object" || !Array.isArray(release.assets)) continue;
    if (release.draft || (channel === "stable" && release.prerelease)) continue;
    const version = String(release.tag_name).replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) continue;
    const filename = `device-deck-${version}-macos-${arch}.pkg`;
    const asset = release.assets.find((a: any) => a?.name === filename);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) continue;
    const url = assetURL(asset.browser_download_url, version, filename);
    if (!url) continue;
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3) continue;
    const metadataName = filename.replace(/\.pkg$/, ".json");
    const metadataAsset = release.assets.find((a: any) => a?.name === metadataName);
    const metadataURL = assetURL(metadataAsset?.browser_download_url, version, metadataName);
    if (!metadataURL || !/^sha256:[a-f0-9]{64}$/.test(metadataAsset?.digest || "") || !Number.isSafeInteger(metadataAsset.size) || metadataAsset.size < 1 || metadataAsset.size > 65536) continue;
    candidates.push({ manifest: { version, filename, url, sha256: asset.digest.slice(7), bytes: asset.size, signing: "developer-id-notarized" }, metadataURL, metadataAsset });
  }
  // Public update discovery only offers complete signed releases. The native
  // privileged installer independently verifies Apple's signature and product.
  for (const candidate of candidates.sort((a,b) => compareVersions(b.manifest.version, a.manifest.version))) {
    try {
      const asset = candidate.metadataAsset;
      const metadataResponse = await transport(candidate.metadataURL, { signal: AbortSignal.timeout(15000) });
      if (!metadataResponse.ok || !metadataResponse.body) continue;
      const reader = metadataResponse.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > asset.size) break;
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks);
      if (size !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.digest.slice(7)) continue;
      let metadata;
      try { metadata = JSON.parse(bytes.toString()); } catch { continue; }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const manifest = candidate.manifest;
      if (metadata.application !== "com.tantawowa.device-deck" || metadata.version !== manifest.version || metadata.arch !== arch ||
          metadata.file !== manifest.filename || metadata.sha256 !== manifest.sha256 || metadata.bytes !== manifest.bytes ||
          metadata.signing !== "developer-id-notarized" || metadata.media !== "bundled") continue;
      return { manifest: { ...manifest, signing: "developer-id-notarized" } };
    } catch { continue; }
  }
}
export async function downloadMacUpdate(release: MacRelease, directory: string, transport = fetch) {
  const m = release.manifest;
  if (path.basename(m.filename) !== m.filename || !/^device-deck-.*\.pkg$/.test(m.filename)) throw new Error("Invalid installer filename.");
  const url = assetURL(m.url, m.version, m.filename);
  if (!url || m.signing !== "developer-id-notarized" || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > 2 * 1024 ** 3) throw new Error("Invalid signed installer manifest.");
  const response = await transport(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Installer download failed (${response.status}).`);
  if (!response.body) throw new Error("The installer download was empty.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, m.filename), temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600), reader = response.body.getReader();
  try {
    let size = 0; const hash = createHash("sha256");
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > m.bytes) throw new Error("Installer checksum or size mismatch.");
      hash.update(value); await file.writeFile(value);
    }
    if (size !== m.bytes || hash.digest("hex") !== m.sha256) throw new Error("Installer checksum or size mismatch.");
    await file.sync(); await file.close(); await rename(temporary, target);
  } finally { await file.close(); await reader.cancel().catch(() => {}); await rm(temporary, { force: true }); }
  return target;
}
