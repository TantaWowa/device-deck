import { fail } from "../../core/src/local/types";
import { run } from "./process";

export async function androidUserApps(adb: string, args: string[], execute: typeof run, sideloadedOnly = false) {
  // Older Android releases silently return an empty package list for
  // --user all. Enumerate numeric user IDs so every profile is covered.
  const users = await execute(adb, [...args, "shell", "pm", "list", "users"], 30000);
  if (users.stderr.trim())
    fail("app-list-invalid", `Android could not list all user profiles: ${users.stderr.trim().slice(-600)}`, 502);
  const userIds = new Set<string>();
  for (const line of users.stdout.toString().split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (line === "Users:") continue;
    const match = /^UserInfo\{(\d+):.*\}(?:\s+.*)?$/.exec(line);
    if (!match)
      fail("app-list-invalid", "Android returned an invalid user-profile list. No apps were removed.", 502);
    userIds.add(match[1]);
  }
  if (!userIds.size)
    fail("app-list-invalid", "Android returned no user profiles. No apps were removed.", 502);
  const packages = new Set<string>();
  for (const userId of userIds) {
    // -3 excludes system packages; adb uninstall removes each package for all users.
    const listed = await execute(adb, [...args, "shell", "pm", "list", "packages", "-3", ...(sideloadedOnly ? ["-i"] : []), "--user", userId], 30000);
    if (listed.stderr.trim())
      fail("app-list-invalid", `Android could not list apps for user ${userId}: ${listed.stderr.trim().slice(-600)}`, 502);
    for (const line of listed.stdout.toString().split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const [entry, installer] = line.split(/\s+installer=/);
      if (sideloadedOnly && !installer)
        fail("app-list-invalid", "Android did not report the installer for a third-party app.", 502);
      const match = /^package:([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(entry);
      if (!match)
        fail("app-list-invalid", "Android returned an invalid installed-app list. No apps were removed.", 502);
      if (!sideloadedOnly || installer === "null" || installer === "com.android.shell") packages.add(match[1]);
    }
  }
  return [...packages].sort();
}

export async function uninstallAndroidApp(adb: string, args: string[], appId: string, execute: typeof run) {
  const result = await execute(adb, [...args, "uninstall", appId], 60000);
  if (result.stdout.toString().trim() !== "Success")
    throw new Error((result.stdout.toString().trim() || result.stderr.trim() || "Uninstall did not report success").slice(-400));
}
