import { mkdir, writeFile, rename, rm } from "node:fs/promises";
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
export async function checkMacUpdates({ channel = "beta", arch = process.arch, transport = fetch }: { channel?: "beta" | "stable"; arch?: string; transport?: typeof fetch } = {}): Promise<MacRelease | undefined> {
  const response = await transport(`${repository}/releases?per_page=100`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error("Invalid GitHub release collection.");
  const candidates: MacRelease[] = [];
  for (const release of releases) {
    if (release.draft || (channel === "stable" && release.prerelease)) continue;
    const version = String(release.tag_name).replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) continue;
    const filename = `device-deck-${version}-macos-${arch}.pkg`;
    const asset = release.assets?.find((a: any) => a.name === filename);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) continue;
    const url = new URL(asset.browser_download_url);
    if (url.origin !== "https://github.com" || !url.pathname.startsWith("/TantaWowa/device-deck/releases/download/")) continue;
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3) continue;
    candidates.push({ manifest: { version, filename, url: url.href, sha256: asset.digest.slice(7), bytes: asset.size, signing: "See release notes" } });
  }
  return candidates.sort((a,b) => compareVersions(b.manifest.version, a.manifest.version))[0];
}
export async function downloadMacUpdate(release: MacRelease, directory: string, transport = fetch) {
  const m = release.manifest;
  if (path.basename(m.filename) !== m.filename || !/^device-deck-.*\.pkg$/.test(m.filename)) throw new Error("Invalid installer filename.");
  const url = new URL(m.url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/TantaWowa/device-deck/releases/download/")) throw new Error("Invalid installer URL.");
  const response = await transport(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Installer download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== m.bytes || createHash("sha256").update(bytes).digest("hex") !== m.sha256) throw new Error("Installer checksum or size mismatch.");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, m.filename), temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  return target;
}
