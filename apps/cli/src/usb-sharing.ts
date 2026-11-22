import { execFileSync } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../../../packages/config/src";
import { callOperation } from "../../../packages/core/src/client";
import { readSharedHost } from "../../../packages/core/src/shared-host";
import type { Config } from "../../../packages/core/src/local/types";

export function desktopUsbSources(config: Config, uid: number, ids: string[]) {
  const next = structuredClone(config);
  const cards = ids.map(id => {
    const source = next.sources.find(s => s.id === id && s.kind === "usb" && s.uniqueId);
    if (!source) throw new Error(`Unknown configured USB capture card: ${id}`);
    if (source.captureDesktopUid !== undefined && source.captureDesktopUid !== uid)
      throw new Error(`${source.name} is already shared by another desktop.`);
    return source;
  });
  if (new Set(ids).size !== ids.length || ids.length > 64) throw new Error("Choose up to 64 distinct USB cards.");
  for (const source of next.sources) {
    if (source.captureDesktopUid === uid) delete source.captureDesktopUid;
  }
  for (const source of cards) source.captureDesktopUid = uid;
  return { config: next, hardware: cards.map(s => s.uniqueId!) };
}

export async function shareDesktopUsb(selection?: string) {
  if (!selection) throw new Error("Use devdeck sharing usb SOURCE_ID[,SOURCE_ID] or off.");
  const uid = process.getuid?.();
  const host = await readSharedHost();
  if (!uid || !host || host.uid === uid) throw new Error("Use this command on the desktop sharing its USB inputs with another account's configured Mac service.");
  const current = await callOperation("config.get") as { config: Config; revision: string };
  const { config, hardware } = desktopUsbSources(current.config, uid, selection === "off" ? [] : selection.split(","));
  const executable = "/Applications/Device Deck.app/Contents/Resources/build/native/deck-camera";
  await access(executable);
  const label = "com.tantawowa.device-deck.usb-sharing";
  const plist = path.join(os.homedir(), "Library/LaunchAgents", label + ".plist");
  const domain = `gui/${uid}`;
  const launch = (...args: string[]) => execFileSync("/bin/launchctl", args, { stdio: "pipe" });
  const loaded = () => { try { launch("print", domain + "/" + label); return true; } catch { return false; } };
  const previous = await readFile(plist).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const wasLoaded = loaded();
  const unload = () => { if (loaded()) launch("bootout", domain + "/" + label); };
  const bootstrap = async () => {
    for (let attempt = 0; ; attempt++) {
      try { launch("bootstrap", domain, plist); return; }
      catch (error) { if (attempt === 9) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
  };
  try {
    unload();
    if (hardware.length) {
      const data = { Label: label, ProgramArguments: [executable, "--share-usb", String(host.uid), ...hardware], RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5, LimitLoadToSessionType: "Aqua" };
      const xml = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], { input: JSON.stringify(data) });
      await atomicWrite(plist, xml);
      await bootstrap();
    } else await rm(plist, { force: true });
    await callOperation("config.save", { config, revision: current.revision });
  } catch (error) {
    unload();
    if (previous) { await atomicWrite(plist, previous); if (wasLoaded) await bootstrap(); }
    else await rm(plist, { force: true });
    throw error;
  }
  return { host: host.username, desktop: os.userInfo().username, sources: config.sources.filter(source => source.captureDesktopUid === uid).map(source => source.id) };
}
