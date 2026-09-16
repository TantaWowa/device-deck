import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { run } from "../../../../packages/adapters/src/process";
import { fail, type Artifact } from "../../../../packages/core/src/local/types";
import { captureDownloadName } from "../../../../packages/core/src/capture-library";

export async function openCaptureFolder(
  folder: string,
  execute = run,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin")
    fail("unsupported-platform", "Open folder on Mac requires Device Deck to run on macOS.", 400);
  const resolved = path.resolve(folder);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  if (!(await stat(resolved)).isDirectory())
    fail("capture-folder-unavailable", "The configured capture folder is not a directory.", 409);
  await execute("/usr/bin/open", ["-a", "Finder", resolved]);
  return { opened: true as const, folder: resolved };
}

/** Count managed files, including originals and sidecars, without crawling the folder. */
export async function captureStorage(artifacts: Artifact[]) {
  const files = new Map<string, { trash: boolean; required: boolean }>();
  for (const a of artifacts) {
    if (a.purgedAt) continue;
    const add = (file: string | undefined, required = true) => {
      if (!file) return;
      const previous = files.get(file);
      files.set(file, { trash: Boolean(a.deletedAt) && (previous?.trash ?? true), required: required || Boolean(previous?.required) });
    };
    add(a.path); add(a.cleanPath); add(a.logPath);
    for (const file of [a.path, a.cleanPath]) if (file)
      add(path.join(path.dirname(file), `annotation-${path.basename(file)}.ass`), false);
  }
  const total = { bytes: 0, libraryBytes: 0, trashBytes: 0, files: 0, missingFiles: 0 };
  const pending = [...files.entries()];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(16, pending.length) }, async () => {
    while (index < pending.length) {
      const [file, metadata] = pending[index++];
      try {
        const info = await stat(file);
        if (!info.isFile()) { if (metadata.required) total.missingFiles++; continue; }
        total.bytes += info.size;
        total[metadata.trash ? "trashBytes" : "libraryBytes"] += info.size;
        total.files++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (metadata.required) total.missingFiles++;
      }
    }
  }));
  return total;
}

export function artifactDisposition(
  artifact: Pick<Artifact, "name" | "kind" | "path" | "cleanPath" | "logPath">,
  variant: "file" | "clean" | "log",
  download: boolean,
) {
  const fileName = captureDownloadName(artifact, variant);
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
