import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { DeckError } from "../../core/src/local/types";
const exec = promisify(execFile);
export async function run(
  command: string,
  args: string[],
  timeout = 15000,
  options: { cwd?: string } = {},
) {
  try {
    const { stdout, stderr } = await exec(command, args, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "buffer",
      windowsHide: true,
      cwd: options.cwd,
    });
    return {
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr).toString(),
    };
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string; killed?: boolean };
    const detail = String(err.stderr || "").trim() || (err.killed
      ? `Timed out after ${Math.round(timeout / 1000)} seconds.`
      : err.message);
    throw new DeckError(
      "adapter-failed",
      `${command}: ${detail.slice(-1800)}`,
      502,
    );
  }
}
export async function available(command: string) {
  // Tool checks run for every online device. Spawning `which`/`test` stalls
  // macOS's event loop under a large inventory; filesystem checks also avoid
  // caching stale results after installing a helper or editing its path.
  const candidates = command.includes("/") || command.includes(path.sep)
    ? [command]
    : (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter).map((directory) => path.join(directory || ".", command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {}
  }
  return false;
}
export function start(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  // Per-helper overrides retain the host's SDK/tool discovery environment.
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env } });
  let stderr = "",
    stdout = "",
    error: Error | undefined,
    exited = false;
  child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-8192)));
  child.stdout.on("data", (c) => (stdout = (stdout + c).slice(-8192)));
  child.on("error", (e) => (error = e));
  child.stdin.on("error", () => {});
  const completed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    }),
  );
  return {
    child,
    completed,
    log: () => error?.message || stderr,
    output: () => stdout,
    exited: () => exited || !!error,
  };
}
export type ProcessHandle = ReturnType<typeof start>;
export async function stop(handle: ProcessHandle) {
  if (!handle.exited()) handle.child.kill("SIGINT");
  const timer = setTimeout(() => {
    if (!handle.exited()) handle.child.kill("SIGKILL");
  }, 8000);
  try {
    return await handle.completed;
  } finally {
    clearTimeout(timer);
  }
}
export async function ready(
  handle: ProcessHandle,
  pattern?: RegExp,
  timeout = 15000,
) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (handle.exited())
      throw new DeckError(
        "capture-failed",
        handle.log() || "Capture exited before producing frames",
        502,
      );
    if (pattern ? pattern.test(handle.log()) : Date.now() - startTime > 600)
      return;
    await new Promise((r) => setTimeout(r, 60));
  }
  await stop(handle);
  throw new DeckError(
    "capture-timeout",
    handle.log() || "Capture did not become ready",
    504,
  );
}
