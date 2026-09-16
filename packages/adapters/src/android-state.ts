import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { run } from "./process";

export function androidFeatures(output: string) {
  const features = new Set(output.split(/\r?\n/).map((line) => line.trim()));
  return {
    inputMode: features.has("feature:android.hardware.type.television") || features.has("feature:android.software.leanback")
      ? "remote" as const : "touch" as const,
    touchscreen: features.has("feature:android.hardware.touchscreen"),
  };
}

/** Read SDK metadata so a stopped TV AVD retains its device class. */
export async function avdInputMode(name: string, directories = [
  process.env.ANDROID_AVD_HOME,
  path.join(process.env.ANDROID_USER_HOME || path.join(os.homedir(), ".android"), "avd"),
]): Promise<"touch" | "remote" | undefined> {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return undefined;
  for (const directory of directories) {
    if (!directory) continue;
    try {
      const pointer = await readFile(path.join(directory, `${name}.ini`), "utf8").catch(() => "");
      const location = pointer.match(/^path=(.+)$/m)?.[1].trim() || path.join(directory, `${name}.avd`);
      const config = await readFile(path.join(location, "config.ini"), "utf8");
      const tags = config.match(/^tag\.ids?=(.+)$/gm)?.flatMap((line) => line.slice(line.indexOf("=") + 1).trim().split(",")) || [];
      if (tags.some((tag) => tag === "android-tv" || tag === "google-tv")) return "remote";
      if (tags.length) return "touch";
    } catch {}
  }
  return undefined;
}

/** ADB's device state only means the transport is ready, not Android itself. */
export async function androidBootReady(adb: string, args: string[], execute = run) {
  try {
    const completed = (await execute(adb, [...args, "shell", "getprop", "sys.boot_completed"], 3000)).stdout.toString().trim();
    if (completed !== "1") return false;
    const animation = (await execute(adb, [...args, "shell", "getprop", "init.svc.bootanim"], 3000)).stdout.toString().trim();
    return !animation || animation === "stopped";
  } catch { return false; }
}

export async function androidDisplayReady(adb: string, args: string[], execute = run) {
  if (!(await androidBootReady(adb, args, execute))) return false;
  try {
    const image = (await execute(adb, [...args, "exec-out", "screencap", "-p"], 5000)).stdout;
    return image.length >= 33 &&
      image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      image.subarray(12, 16).toString() === "IHDR" &&
      image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0 &&
      image.subarray(-8, -4).toString() === "IEND";
  } catch { return false; }
}
