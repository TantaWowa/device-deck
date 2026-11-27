import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export async function verifyReleaseArtifacts({ directory, version, commit, architectures = ["arm64"] }) {
  if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version || "")) throw new Error("A valid release version is required.");
  if (!/^[a-f0-9]{40}$/.test(commit || "")) throw new Error("The exact release commit is required.");
  if (architectures.length !== 1 || architectures[0] !== "arm64") throw new Error("Mac releases support only arm64.");
  const arch = "arm64", name = `device-deck-${version}-macos-${arch}`, filename = `${name}.pkg`;
  const expectedFiles = [filename, `${filename}.sha256`, `${name}.json`];
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedFiles.sort()))
    throw new Error("Release files must contain exactly the arm64 installer, checksum and metadata.");
  for (const file of actual) if (!(await lstat(path.join(directory, file))).isFile()) throw new Error(`Release asset is not a regular file: ${file}`);
  const metadata = JSON.parse(await readFile(path.join(directory, `${name}.json`), "utf8"));
  for (const [field, expected] of Object.entries({
    schemaVersion: 1, application: "com.tantawowa.device-deck", version, arch,
    mode: "free", signing: "developer-id-notarized", media: "bundled", file: filename,
  })) {
    if (metadata[field] !== expected) throw new Error(`Refusing release: ${arch} ${field} must be ${expected}.`);
  }
  for (const [field, expected] of Object.entries({ version, mode: "free", arch, commit }))
    if (metadata.build?.[field] !== expected) throw new Error(`Refusing release: ${arch} build ${field} does not match this release.`);
  const installer = path.join(directory, filename), info = await lstat(installer);
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes !== info.size)
    throw new Error(`Refusing release: ${arch} installer size differs from its metadata.`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(installer)) digest.update(chunk);
  const sha256 = digest.digest("hex");
  if (metadata.sha256 !== sha256) throw new Error(`Refusing release: ${arch} installer checksum differs from its metadata.`);
  if ((await readFile(`${installer}.sha256`, "utf8")).trim() !== `${sha256}  ${filename}`)
    throw new Error(`Refusing release: ${arch} checksum file differs from its installer.`);
  return expectedFiles;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    directory: { type: "string" }, version: { type: "string" }, commit: { type: "string" }, arch: { type: "string", multiple: true },
  } });
  if (!values.directory) throw new Error("Use --directory PATH --version VERSION --commit SHA.");
  const files = await verifyReleaseArtifacts({ directory: values.directory, version: values.version, commit: values.commit,
    ...(values.arch ? { architectures: values.arch } : {}) });
  console.log(`Verified checksums and release metadata for ${files.length / 3} installers at ${values.version}.`);
}
