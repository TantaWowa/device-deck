import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDisposition, captureStorage, openCaptureFolder } from "./local/capture-library";
import { operations } from "../../../packages/core/src/local/types";
import type { Artifact } from "../../../packages/core/src/local/types";

test("storage counts actual unique media, originals and metadata, splitting trash and excluding purged files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-storage-"));
  const make = (id: string): Artifact => ({ id, deviceId: "qa", sessionId: "qa", sourceId: "qa", owner: "QA", name: id, path: path.join(root, `${id}.png`), logPath: path.join(root, `${id}.json`), kind: "screenshot", mode: "clean", tags: [], createdAt: 1, duration: 0, bytes: 999, status: "completed", origin: "Web" });
  const library = make("one"), trash = { ...make("two"), deletedAt: 1 }, purged = { ...make("three"), purgedAt: 1 };
  library.cleanPath = path.join(root, "clean.png");
  try {
    for (const [file, length] of [[library.path, 10], [library.cleanPath, 20], [library.logPath, 5], [path.join(root, "annotation-one.png.ass"), 7], [trash.path, 30], [purged.path, 100]] as const)
      await writeFile(file, Buffer.alloc(length));
    assert.deepEqual(await captureStorage([library, library, trash, purged]), { bytes: 72, libraryBytes: 42, trashBytes: 30, files: 5, missingFiles: 1 });
    assert.deepEqual(await captureStorage([]), { bytes: 0, libraryBytes: 0, trashBytes: 0, files: 0, missingFiles: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("capture folder opening creates only the configured folder and sends its literal path to Finder without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-open-folder-"));
  const folder = path.join(root, "Capture's $(touch escaped); folder");
  const calls: { command: string; args: string[] }[] = [];
  try {
    const result = await openCaptureFolder(folder, async (command, args) => {
      assert((await stat(folder)).isDirectory(), "Folder exists before Finder opens");
      calls.push({ command, args });
      return { stdout: Buffer.alloc(0), stderr: "" };
    }, "darwin");
    assert.deepEqual(result, { opened: true, folder });
    assert.deepEqual(calls, [{ command: "/usr/bin/open", args: ["-a", "Finder", folder] }]);
    assert.deepEqual(operations["captures.openFolder"].parse({}), {});
    assert.throws(() => operations["captures.openFolder"].parse({ path: "/tmp/another" }));
    await assert.rejects(openCaptureFolder(path.join(root, "unsupported"), undefined, "linux"), /requires Device Deck to run on macOS/);
    await assert.rejects(stat(path.join(root, "unsupported")), { code: "ENOENT" });
    await assert.rejects(openCaptureFolder(folder, async () => { throw new Error("Finder failed"); }, "darwin"), /Finder failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("download names preserve edited Unicode names while escaping header syntax and path separators", () => {
  const paths = { path: "/tmp/example.png", logPath: "/tmp/example.png.json" };
  const file = artifactDisposition({ ...paths, name: "Café's / focus\r\n\"shot\"", kind: "screenshot" }, "file", true);
  assert(file.startsWith("attachment; filename="));
  assert(!file.includes("\r") && !file.includes("\n"));
  assert(file.includes("filename*=UTF-8''Caf%C3%A9%27s%20_%20focus___shot_.png"));
  assert.match(artifactDisposition({ ...paths, path: "/tmp/demo.mp4", name: "Demo", kind: "recording" }, "clean", false), /^inline; .*Demo-clean\.mp4/);
  assert.match(artifactDisposition({ ...paths, name: "Demo", kind: "recording" }, "log", true), /^attachment; .*Demo-metadata\.json/);
});
