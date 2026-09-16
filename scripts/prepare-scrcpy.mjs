import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(await readFile(path.join(root, "scripts/distribution/scrcpy.json"), "utf8"));
export async function prepareScrcpy(directory = path.join(root, "build/native")) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `scrcpy-server-v${pin.version}`);
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  let cached;
  try { cached = await readFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!cached || digest(cached) !== pin.sha256) {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Could not download pinned scrcpy ${pin.version}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (digest(data) !== pin.sha256) throw new Error("Pinned scrcpy server SHA-256 verification failed.");
    const temporary = `${file}.${process.pid}.tmp`;
    try { await writeFile(temporary, data); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  const license = await readFile(path.join(root, "native/scrcpy-LICENSE"));
  await writeFile(path.join(directory, "scrcpy-LICENSE"), license);
  return file;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await prepareScrcpy());
