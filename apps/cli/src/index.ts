#!/usr/bin/env node
import { resolveReportRange } from "../../../packages/core/src/reports";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  callOperation,
  callService,
  browserUrl,
} from "../../../packages/core/src/client";
import {
  operations,
  type Operation,
  type Selector,
  type Snapshot,
  matchDevices,
  DeckError,
} from "../../../packages/core/src/local/types";
import {
  ConfigStore,
  validateConfig,
  atomicWrite,
} from "../../../packages/config/src";
import { dataDirectory } from "../../../packages/core/src/local/paths";
import { root } from "../../../packages/adapters/src";
import path from "node:path";
import { lifecycle } from "./lifecycle";
import { tailscaleCommand, tailscaleBrowserUrl } from "./tailscale";
import { pick, parseSelector } from "./selection";
import { selectFeeds, feedQuery } from "./feeds";
import { checkMacUpdates, compareVersions, downloadMacUpdate } from "../../../packages/installer/src/mac-update";
import { releaseMode } from "../../../packages/licensing/src/trust";
import { version } from "../../../packages/core/src/version";
const help = `Device Deck · local Mac device manager
Usage: devdeck <command> [options]

  init                         Create a local config file
  start | stop | status | logs  Run and inspect the daemon
  install | uninstall          Enable/remove the login service
  service <action>             Explicit start/stop/status/logs/install/uninstall
  version | doctor             Inspect installed version and capture readiness
  update check|download        Find/download a verified Mac installer
       [--channel beta|stable] [--key-file FILE] [--output DIRECTORY]
  ui | tui | mcp               Open the dashboard, terminal UI or MCP server
  ui [--tailscale] [--json]    Open the dashboard or print its URL as JSON
  tailscale enable|status|disable  Manage private HTTPS access over Tailscale
       [--allow-user LOGIN,LOGIN] [--https-port PORT]
  discover                     Find connected targets and capture cards
  feeds                        List capture feeds and stable IDs
  view [--source NAME_OR_ID]    Open a browser feed; Left/Right switches feeds
       [--sources A,B,C] [--mux] [--browser] [--json]
  devices [filters]            List configured devices
  sources | sessions | captures | history
  reports [--range day|week|month|custom] [--start YYYY-MM-DD --end YYYY-MM-DD]
  license status|refresh|deactivate
  license activate <key-file>  Read a license key from a private file
  config [get|import|export|validate] [file]
  reserve [filters] --owner NAME --reason TEXT
  renew | release              Use --session ID --lease TOKEN
  remote [filters]             Interactive remote and device picker
  apple-pair [filters]         Reserve and pair Apple TV with its on-screen PIN
  input --key Home             Use --session and --lease; or --text TEXT
  screenshot [--clipboard]     Use --session and --lease
  record start|stop            Use --session and --lease
  lock|unlock|restart [filters] --reason TEXT
  takeover [filters] --owner NAME --reason TEXT --yes
  call OPERATION JSON          Every shared API operation, including metadata

Filters: --device NAME_OR_ID --platform Roku|Android|Apple|Other --name TEXT
         --state free|reserved|online|offline|locked --capabilities key,record
Options: --json --ttl MINUTES --mode clean|annotated

Interactive remote reserves a device with a reason. Arrow keys navigate;
Enter selects, b is Back, h is Home, s takes a screenshot, r toggles recording,
t sends text and q releases and quits. Noninteractive selectors never prompt.
Captures save in the configured Mac folder. Removing a capture moves it to
Device Deck trash; permanent deletion is an explicit API action.
Exit codes: 0 success, 1 service/operation failure, 2 invalid arguments.
`;
const optionTypes: Record<string, { type: "string" | "boolean" }> =
  Object.fromEntries(
    [
      "device",
      "platform",
      "name",
      "state",
      "capabilities",
      "owner",
      "reason",
      "session",
      "lease",
      "ttl",
      "key",
      "text",
      "mode",
      "range",
      "start",
      "end",
      "source",
      "sources",
      "channel",
      "key-file",
      "output",
      "allow-user",
      "https-port",
    ].map((k) => [k, { type: "string" }]),
  );
for (const key of ["json", "help", "clipboard", "yes", "mux", "browser", "version", "tailscale"])
  optionTypes[key] = { type: "boolean" };
try {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: optionTypes,
  });
  const command = v.version ? "version" : p[0] === "service" ? (p[1] || "status") : p[0];
  if (p[0] === "service" && !["start", "stop", "status", "logs", "install", "uninstall"].includes(command)) throw new DeckError("arguments", "Use service start, stop, status, logs, install or uninstall.", 400);
  if (!command || v.help) {
    console.log(help);
  } else {
    const selector = parseSelector(v);
    const lease = () => {
      if (!v.session || !v.lease)
        throw new DeckError(
          "arguments",
          "Supply --session and --lease from reserve.",
          400,
        );
      return { sessionId: String(v.session), leaseToken: String(v.lease) };
    };
    const reason = () => {
      if (!v.reason)
        throw new DeckError(
          "arguments",
          "Supply --reason explaining the action.",
          400,
        );
      return String(v.reason);
    };
    let result: unknown;
    if (command === "version") result = { version, mode: releaseMode, platform: process.platform, arch: process.arch };
    else if (command === "doctor") {
      let metadata: unknown;
      try { metadata = JSON.parse(await readFile(path.join(root, "build/build-metadata.json"), "utf8")); } catch {}
      try {
        const inventory: Snapshot = await callOperation("inventory");
        result = { version, mode: releaseMode, build: metadata, service: "running", license: inventory.license, diagnostics: inventory.diagnostics, devices: inventory.devices.length, sources: inventory.sources.length };
      } catch (error) {
        result = { version, mode: releaseMode, build: metadata, service: "unavailable", message: (error as Error).message, next: "Open Device Deck.app or run devdeck service start, then run devdeck doctor again." };
        process.exitCode = 1;
      }
    } else if (command === "update") {
      const action = p[1] || "check";
      if (!["check", "download"].includes(action) || (v.channel && !["beta", "stable"].includes(String(v.channel)))) throw new DeckError("arguments", "Use update check|download with --channel beta|stable.", 400);
      let key: string | undefined;
      if (v["key-file"]) key = (await readFile(String(v["key-file"]), "utf8")).trim();
      else {
        try { key = JSON.parse(await readFile(path.join(dataDirectory(), "license.json"), "utf8")).key; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Saved license cannot be read. Use --key-file with a private license file."); }
      }
      const release = await checkMacUpdates({ key, ...(v.channel ? { channel: String(v.channel) as "beta" | "stable" } : {}) });
      if (!release) result = { currentVersion: version, available: false, message: "No verified package is available for this release channel and Mac." };
      else if (action === "check") result = { currentVersion: version, available: compareVersions(release.manifest.version, version) > 0, release: release.manifest };
      else {
        if (compareVersions(release.manifest.version, version) < 0) throw new Error("The available package is older than this version. Automatic downgrade is not supported.");
        const file = await downloadMacUpdate(release, path.resolve(String(v.output || path.join(dataDirectory(), "updates"))), key);
        result = { file, version: release.manifest.version, signing: release.manifest.signing, next: "Finish reservations and recordings, quit Device Deck, then open this installer. Homebrew users should upgrade through Homebrew." };
      }
    } else if (command === "status") result = await callService("health");
    else if (
      ["start", "stop", "install", "uninstall", "logs"].includes(command)
    )
      result = await lifecycle(command);
    else if (command === "init") {
      const store = new ConfigStore(path.join(dataDirectory(), "config.json"));
      await store.load();
      result = { file: store.file, config: store.config };
    } else if (command === "tailscale") {
      const action = p[1] || "status";
      const access = await tailscaleCommand(action, {
        ...(v["allow-user"] !== undefined ? { allowUser: String(v["allow-user"]) } : {}),
        ...(v["https-port"] !== undefined ? { httpsPort: String(v["https-port"]) } : {}),
      });
      if (action === "status" && !access.healthy) process.exitCode = 1;
      result = access;
    } else if (command === "ui") {
      const url = v.tailscale ? await tailscaleBrowserUrl() : await browserUrl();
      if (v.json) result = { url };
      else {
        spawn("/usr/bin/open", [url], { stdio: "ignore" });
        result = `Opened ${v.tailscale ? "Tailscale" : "local"} dashboard.`;
      }
    } else if (command === "feeds" || command === "view") {
      const cards = await callOperation("capture-cards.list");
      if (command === "feeds") {
        if (v.json) result = cards;
        else {
          console.table(
            cards.sources.map((s: any) => ({
              name: s.name,
              id: s.id,
              hardware: s.uniqueId,
              status: s.status,
            })),
          );
          for (const diagnostic of cards.diagnostics) console.error(diagnostic);
        }
      } else {
        if (v.source && v.sources)
          throw new DeckError(
            "arguments",
            "Use --source or --sources, not both.",
            400,
          );
        const current = await callOperation("config.get");
        let requested = String(v.source || v.sources || "") || undefined;
        if (Object.values(selector).some((value) => value !== undefined)) {
          if (requested)
            throw new DeckError(
              "arguments",
              "Choose device filters or source selectors.",
              400,
            );
          const inventory: Snapshot = await callOperation("inventory");
          const devices = matchDevices(
            inventory.devices,
            inventory.sessions,
            selector,
          );
          requested = devices
            .map((d) => d.captureSourceId)
            .filter(Boolean)
            .join(",");
          if (!requested)
            throw new DeckError(
              "arguments",
              "Matching devices have no USB capture feeds.",
              400,
            );
        }
        const registered = cards.sources.filter((s: any) =>
          current.config.sources.some((c: any) => c.id === s.id),
        );
        const feeds = selectFeeds(
          requested || !registered.length ? cards.sources : registered,
          requested,
        );
        const config = structuredClone(current.config);
        for (const s of feeds)
          if (!config.sources.some((c: any) => c.id === s.id))
            config.sources.push({
              id: s.id,
              name: s.name,
              kind: s.kind,
              uniqueId: s.uniqueId,
            });
        if (config.sources.length !== current.config.sources.length)
          await callOperation("config.save", {
            config,
            revision: current.revision,
          });
        const url = await browserUrl(
          feedQuery(
            feeds.map((s) => s.id),
            Boolean(v.mux),
          ),
        );
        if (v.json)
          result = {
            url,
            layout: v.mux ? "grid" : "single",
            feeds: feeds.map((s) => ({ id: s.id, name: s.name })),
          };
        else {
          spawn("/usr/bin/open", [url], { stdio: "ignore" });
          result = `Opened ${feeds.length} feed${feeds.length === 1 ? "" : "s"} in ${v.mux ? "split-screen" : "single-feed"} view. Left/Right: switch · G: grid · F: fullscreen.`;
        }
      }
    } else if (command === "mcp" || command === "tui") {
      await import(
        command === "mcp"
          ? "../../../packages/mcp/src/index"
          : "../../tui/src/index"
      );
    } else if (command === "discover") result = await callOperation("discover");
    else if (command === "config") {
      const sub = p[1] || "get";
      if (sub === "validate") {
        if (!p[2]) throw new Error("Supply a JSON file.");
        result = validateConfig(JSON.parse(await readFile(p[2], "utf8")));
      } else {
        const current = await callOperation("config.get");
        if (sub === "get") result = current;
        else if (sub === "export") {
          if (!p[2]) throw new Error("Supply an output file.");
          await atomicWrite(
            path.resolve(p[2]),
            JSON.stringify(current.config, null, 2) + "\n",
          );
          result = "Configuration exported.";
        } else if (sub === "import") {
          if (!p[2]) throw new Error("Supply a JSON file.");
          result = await callOperation("config.save", {
            config: JSON.parse(await readFile(p[2], "utf8")),
            revision: current.revision,
          });
        } else throw new Error("Unknown config command.");
      }
    } else if (command === "license") {
      const action = p[1] || "status";
      if (action === "activate") {
        if (!p[2])
          throw new Error("Supply a private file containing your license key.");
        result = await callOperation("license.activate", {
          key: (await readFile(p[2], "utf8")).trim(),
        });
      } else if (["status", "refresh", "deactivate"].includes(action)) {
        result = await callOperation(`license.${action}` as Operation);
      } else
        throw new Error("Use license status, activate, refresh or deactivate.");
    } else if (command === "reports") {
      let request;
      try {
        request = operations["reports.get"].parse({
          ...(v.range ? { preset: v.range } : {}),
          ...(v.start ? { start: v.start } : {}),
          ...(v.end ? { end: v.end } : {}),
        });
        resolveReportRange(request);
      } catch (e) {
        throw new DeckError("arguments", (e as Error).message, 400);
      }
      result = await callOperation("reports.get", request);
    } else if (
      ["devices", "sources", "sessions", "captures", "history"].includes(
        command,
      )
    ) {
      const data: Snapshot = await callOperation("inventory");
      result =
        command === "devices"
          ? matchDevices(data.devices, data.sessions, selector)
          : command === "history"
            ? data.events
            : command === "captures"
              ? data.artifacts
              : data[command as "sources" | "sessions"];
      if (command === "devices" && !v.json) {
        console.table(
          (result as Snapshot["devices"]).map((d) => ({
            name: d.name,
            platform: d.platform,
            kind: d.kind,
            health: d.online ? "online" : "offline",
            state: d.locked
              ? "locked"
              : data.sessions.find(
                  (s) => s.deviceId === d.id && s.state !== "closed",
                )?.owner || "free",
            source: d.captureSourceId || "none",
          })),
        );
        result = undefined;
      }
    } else if (command === "reserve") {
      const device = await pick(selector, !v.json);
      result = await callOperation("sessions.reserve", {
        selector: { device: device.id },
        owner: String(v.owner || "CLI"),
        reason: reason(),
        ...(v.ttl ? { ttlMinutes: Number(v.ttl) } : {}),
      });
    } else if (command === "renew" || command === "release")
      result = await callOperation(
        command === "renew" ? "sessions.renew" : "sessions.release",
        {
          ...lease(),
          ...(command === "renew" && v.ttl
            ? { ttlMinutes: Number(v.ttl) }
            : {}),
        },
      );
    else if (command === "takeover") {
      if (!v.yes) throw new Error("Takeover requires --yes and --reason.");
      const device = await pick(selector, !v.json);
      result = await callOperation("sessions.takeover", {
        deviceId: device.id,
        owner: String(v.owner || "CLI"),
        reason: reason(),
        confirmed: true,
      });
    } else if (["lock", "unlock", "restart"].includes(command)) {
      const d = await pick(selector, !v.json);
      result = await callOperation("devices.bulk", {
        ids: [d.id],
        action: command,
        reason: reason(),
      });
    } else if (command === "input")
      result = await callOperation("remote.input", {
        ...lease(),
        ...(v.key ? { key: v.key } : {}),
        ...(v.text ? { text: v.text } : {}),
      });
    else if (command === "screenshot")
      result = await callOperation("captures.screenshot", {
        ...lease(),
        ...(v.mode ? { mode: v.mode } : {}),
        ...(v.clipboard ? { clipboard: true } : {}),
      });
    else if (command === "record") {
      if (!["start", "stop"].includes(p[1]))
        throw new Error("Use record start or record stop.");
      result = await callOperation(
        p[1] === "start" ? "recordings.start" : "recordings.stop",
        { ...lease(), ...(p[1] === "start" && v.mode ? { mode: v.mode } : {}) },
      );
    } else if (command === "call") {
      if (!Object.hasOwn(operations, p[1]))
        throw new Error("Unknown API operation.");
      result = await callOperation(p[1] as Operation, JSON.parse(p[2] || "{}"));
    } else if (command === "apple-pair") {
      if (!process.stdin.isTTY)
        throw new Error(
          "Pairing PIN requires a terminal. Agents can use pairing.start and pairing.finish.",
        );
      const device = await pick(selector);
      const acquired = await callOperation("sessions.reserve", {
        selector: { device: device.id },
        owner: String(v.owner || "CLI"),
        reason: "Pair Apple TV Companion",
      });
      const l = {
        sessionId: acquired.session.id,
        leaseToken: acquired.leaseToken,
      };
      try {
        await callOperation("pairing.start", l);
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        let pin: string;
        try {
          pin = await rl.question("PIN shown on Apple TV: ");
        } finally {
          rl.close();
        }
        result = await callOperation("pairing.finish", { ...l, pin });
      } finally {
        await callOperation("sessions.release", l);
      }
    } else if (command === "remote") {
      if (!process.stdin.isTTY)
        throw new Error(
          "Interactive remote requires a terminal. Use input for scripts.",
        );
      const device = await pick(selector);
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const why = String(
        v.reason || (await rl.question("Reservation reason: ")),
      );
      rl.close();
      const acquired = await callOperation("sessions.reserve", {
        selector: { device: device.id },
        owner: String(v.owner || "CLI"),
        reason: why,
      });
      const { interactiveRemote } = await import("../../tui/src/remote");
      await interactiveRemote(device, acquired);
    } else
      throw new DeckError(
        "arguments",
        "Unknown command. Run devdeck --help.",
        400,
      );
    if (result !== undefined)
      console.log(
        typeof result === "string" && !v.json
          ? result
          : JSON.stringify(result, null, 2),
      );
  }
} catch (error) {
  const e = error as DeckError;
  console.error(
    JSON.stringify({
      error: e.code || "operation-failed",
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
    }),
  );
  process.exitCode =
    e.code === "arguments" || e.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
}
