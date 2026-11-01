import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { DeckError } from "../../core/src/local/types";
export async function run(
  command: string,
  args: string[],
  timeout = 15000,
  options: { cwd?: string; signal?: AbortSignal; maxOutputBytes?: number } = {},
) {
  if (options.signal?.aborted)
    throw new DeckError("adapter-cancelled", `${command}: Command cancelled.`, 499);
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: string | undefined, cancelled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: string, abort = false) => {
      if (failure) return;
      failure = reason; cancelled = abort;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
      escalation.unref();
    };
    const abort = () => terminate("Command cancelled.", true);
    const timer = timeout > 0 ? setTimeout(() => terminate(`Timed out after ${Math.round(timeout / 1000)} seconds.`), timeout) : undefined;
    timer?.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    // An abort between the preflight and listener registration must also cancel.
    if (options.signal?.aborted) abort();
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 32 * 1024 * 1024)) { terminate("Command output exceeded its byte limit."); return; }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => { failure ||= error.message; });
    // Do not settle on abort/timeout until the owned child has actually closed.
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      const errorOutput = Buffer.concat(stderr).toString();
      if (failure || code !== 0) {
        const detail = failure || errorOutput.trim() || `Command failed (exit ${code ?? signal}).`;
        reject(new DeckError(cancelled ? "adapter-cancelled" : "adapter-failed", `${command}: ${detail.slice(-1800)}`, cancelled ? 499 : 502));
      } else resolve({ stdout: Buffer.concat(stdout), stderr: errorOutput });
    });
  });
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
