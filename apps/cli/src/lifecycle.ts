import { spawn } from "node:child_process";
import { open, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  callService,
  callOperation,
  endpoint,
} from "../../../packages/core/src/client";
import { dataDirectory } from "../../../packages/core/src/local/paths";
import { root } from "../../../packages/adapters/src";
import { run } from "../../../packages/adapters/src/process";
import { atomicWrite } from "../../../packages/config/src";
import { existsSync } from "node:fs";
const plist = path.join(
  os.homedir(),
  "Library/LaunchAgents/com.tantawowa.device-deck.plist",
);
const label = `gui/${process.getuid!()}/com.tantawowa.device-deck`;
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Launch the packaged daemon through LaunchServices so camera access belongs to
// Device Deck even when the entry point is a terminal, TUI or login service.
export function packagedApplication() {
  const bundle = path.resolve(root, "../..");
  return root.endsWith("/Contents/Resources") &&
    existsSync(path.join(bundle, "Contents/MacOS/Device Deck"))
    ? bundle
    : undefined;
}
const androidEnvironmentKeys = ["ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_USER_HOME", "ANDROID_AVD_HOME"];
export function applicationArgs(bundle: string, directory: string, environment = process.env) {
  return ["-n", "-g", "-a", bundle,
    ...androidEnvironmentKeys.flatMap(key => environment[key] ? ["--env", `${key}=${environment[key]}`] : []),
    "--args", "--service", "--profile", directory,
    ...[["DEVICE_DECK_CONFIG", "--config"], ["DEVICE_DECK_PORT", "--port"], ["DEVICE_DECK_HOST", "--host"]].flatMap(([key, flag]) =>
      environment[key] ? [flag, environment[key]!] : []),
  ];
}
export async function lifecycle(command: string, launchArgs?: string[]) {
  const directory = dataDirectory(),
    entry = path.join(root, "build/daemon.mjs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (command === "start") {
    try {
      await callService("health");
      return "Device Deck is already running.";
    } catch {}
    const bundle = packagedApplication();
    if (bundle && !launchArgs && process.env.DEVICE_DECK_HEADLESS !== "1") {
      await run("/usr/bin/open", applicationArgs(bundle, directory));
    } else {
      const log = await open(path.join(directory, "daemon.log"), "a", 0o600);
      const child = spawn(process.execPath, launchArgs || [entry], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: process.env,
      });
      child.unref();
      await log.close();
    }
    for (let i = 0; i < 300; i++) {
      try {
        await callService("health");
        return "Device Deck started.";
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(
      `Service did not start. Read ${path.join(directory, "daemon.log")}`,
    );
  }
  if (command === "stop") {
    const ep = await endpoint();
    const health = await callService("health");
    if (health.pid !== ep.pid)
      throw new Error("The service changed while checking its identity. Run devdeck status and retry.");
    // A matching authenticated endpoint confirms that the PID belongs to this daemon.
    process.kill(ep.pid, "SIGTERM");
    for (let i = 0; i < 150; i++) {
      try {
        process.kill(ep.pid, 0);
      } catch {
        return "Device Deck stopped.";
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return "Device Deck is finalizing captures. Check status or logs for completion.";
  }
  if (command === "logs")
    return readFile(path.join(directory, "daemon.log"), "utf8").then((s) =>
      s.slice(-24000),
    );
  if (command === "install") {
    let running = false;
    try {
      await callService("health");
      running = true;
    } catch {}
    if (running) {
      const inventory = await callOperation("inventory");
      if (inventory.recordings.length || inventory.sessions.some((s: { state: string }) => s.state !== "closed"))
        throw new Error(
          "Finish active reservations and recordings before installing the login service.",
        );
      const stopped = await lifecycle("stop");
      if (stopped !== "Device Deck stopped.") throw new Error(stopped);
    }
    await mkdir(path.dirname(plist), { recursive: true });
    const pathValue = [
      path.dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      process.env.PATH || "",
    ].join(":");
    const bundle = packagedApplication();
    const programArguments = bundle
      ? ["/usr/bin/open", ...applicationArgs(bundle, directory)]
      : [process.execPath, entry];
    await atomicWrite(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.tantawowa.device-deck</string><key>ProgramArguments</key><array>${programArguments.map((value) => `<string>${escape(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>DEVICE_DECK_HOME</key><string>${escape(directory)}</string><key>PATH</key><string>${escape(pathValue)}</string>${[
        "DEVICE_DECK_CONFIG",
        "DEVICE_DECK_PORT",
        "DEVICE_DECK_HOST",
        ...androidEnvironmentKeys,
      ]
        .filter((key) => process.env[key])
        .map(
          (key) =>
            `<key>${key}</key><string>${escape(process.env[key]!)}</string>`,
        )
        .join(
          "",
        )}</dict><key>StandardOutPath</key><string>${escape(path.join(directory, "daemon.log"))}</string><key>StandardErrorPath</key><string>${escape(path.join(directory, "daemon.log"))}</string><key>ExitTimeOut</key><integer>180</integer></dict></plist>`,
    );
    await run("/bin/launchctl", ["bootout", label]).catch(() => {});
    await run("/bin/launchctl", [
      "bootstrap",
      `gui/${process.getuid!()}`,
      plist,
    ]);
    for (let n = 0; n < 150; n++) {
      try {
        await callService("health");
        return "Device Deck is running and will start at login.";
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(
      "Login service was installed but is not ready. Run devdeck logs.",
    );
  }
  if (command === "uninstall") {
    let running = false;
    try { await callService("health"); running = true; } catch {}
    if (running) {
      const inventory = await callOperation("inventory");
      if (inventory.recordings.length || inventory.sessions.some((s: { state: string }) => s.state !== "closed"))
        throw new Error("Finish active reservations and recordings before removing the login service.");
    }
    await run("/bin/launchctl", ["bootout", label]).catch(() => {});
    try {
      await lifecycle("stop");
    } catch {}
    await rm(plist, { force: true });
    return "Login service removed. Your configuration, captures and application files are retained.";
  }
  throw new Error("Unknown service command.");
}
