import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { DeviceConfig } from "../../core/src/local/types";
import { DeckError } from "../../core/src/local/types";
import type { DeviceLogs, InteractionCapabilities, UiNode, UiRead, UiSnapshot } from "../../core/src/device-interaction";
import type { InteractiveSource } from "../../core/src/live";
import { run, start, stop } from "./process";
import { startWdaInteractive, type WdaConnection } from "./webdriveragent";

export type ObservationHost = {
  execute: typeof run;
  tool(name: "adb" | "idb"): string;
  adb(): string[];
  verify(): Promise<unknown>;
  wda(): Promise<WdaConnection>;
  ownership?: { opened(sessionId: string): void; closed(): void };
};
export interface ObservationAdapter {
  readonly capabilities: InteractionCapabilities;
  ui(options: UiRead): Promise<UiSnapshot>;
  logs(options: DeviceLogs): Promise<{ text: string; truncated: boolean; since: string; until: string }>;
  appState(appId?: string): Promise<Record<string, unknown>>;
  launch(appId: string, args: string[]): Promise<unknown>;
  close(): Promise<void>;
}
const unsupported = (operation: string): never => { throw new DeckError("unsupported-capability", `This device adapter does not support ${operation}.`, 409); };
const decode = (s: string) => s.replace(/&(?:quot|apos|lt|gt|amp);|&#(?:x[\da-f]+|\d+);/gi, (entity) => {
  const named: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
  if (named[entity]) return named[entity];
  const value = entity.slice(2, -1);
  const point = value[0]?.toLowerCase() === "x" ? parseInt(value.slice(1), 16) : parseInt(value, 10);
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
});
const text = (value: unknown): string | null => value == null ? null : String(value).slice(0, 4096);
const bool = (value: unknown): boolean | null => value === true || value === "true" || value === 1 || value === "1" ? true : value === false || value === "false" || value === 0 || value === "0" ? false : null;

export function androidUi(xml: string): unknown[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unexpected Android UI document type.");
  const roots: any[] = [], stack: any[] = [];
  for (const match of xml.matchAll(/<\/?node\b[^>]*>/g)) {
    if (match[0].startsWith("</")) { stack.pop(); continue; }
    const node: any = { children: [] };
    for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node[attribute[1]] = decode(attribute[2]);
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.bounds || "");
    if (bounds) node.frame = { x: Number(bounds[1]), y: Number(bounds[2]), width: Number(bounds[3]) - Number(bounds[1]), height: Number(bounds[4]) - Number(bounds[2]) };
    (stack.at(-1)?.children || roots).push(node);
    if (!match[0].endsWith("/>")) stack.push(node);
  }
  if (!xml.includes("</hierarchy>")) throw new Error("Android returned an incomplete UI hierarchy.");
  return roots;
}

export function normalizeUi(value: any, options: UiRead, coordinateSpace: "points" | "pixels"): UiSnapshot {
  const nodes: UiNode[] = [];
  let visited = 0, truncated = false;
  const visit = (raw: any, depth: number) => {
    if (!raw || typeof raw !== "object") return;
    if (depth > options.maxDepth || visited >= options.maxNodes) { truncated = true; return; }
    visited++;
    const type = text(raw.type ?? raw.AXRole ?? raw.class ?? raw.role);
    const secure = /secure|password/i.test(type || "") || raw.password === "true";
    const frame = raw.rect ?? raw.frame;
    const bounds = frame && [frame.x, frame.y, frame.width, frame.height].every((n: unknown) => typeof n === "number" && Number.isFinite(n))
      ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null;
    const node: UiNode = {
      id: text(raw.AXUniqueId ?? raw.rawIdentifier ?? raw.identifier ?? raw["resource-id"] ?? raw.name), type,
      label: secure ? "[secure]" : text(raw.AXLabel ?? raw.label ?? (raw["content-desc"] || raw.text)),
      value: secure ? "[secure]" : text(raw.AXValue ?? raw.value ?? raw.text),
      enabled: bool(raw.enabled ?? raw.isEnabled ?? raw.AXEnabled), selected: bool(raw.selected ?? raw.isSelected ?? raw.checked), focused: bool(raw.focused ?? raw.isFocused), bounds, depth,
    };
    const selector = options.selector;
    if (!selector || (selector.id === undefined || node.id === selector.id) && (selector.label === undefined || node.label === selector.label) && (selector.type === undefined || node.type === selector.type)) nodes.push(node);
    if (Array.isArray(raw.children)) for (const child of raw.children) visit(child, depth + 1);
  };
  const roots = Array.isArray(value) ? value : Array.isArray(value?.elements) ? value.elements : [value];
  for (const root of roots) visit(root, 0);
  return { nodes, truncated, coordinateSpace };
}

export function boundedLogs(raw: string, options: DeviceLogs) {
  const redacted = raw.replace(/(["']?(?:authorization|cookie|password|access[_-]?token|refresh[_-]?token|api[_-]?key)["']?\s*[=:]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|(?:\\)?$)|'(?:\\[\s\S]|[^'\\])*(?:'|(?:\\)?$)|[^\r\n,]+)/gi, "$1[REDACTED]");
  const lines = redacted.split(/\r?\n/);
  const selected = lines.slice(0, options.maxLines).join("\n");
  const bytes = Buffer.from(selected);
  return { text: new StringDecoder("utf8").write(bytes.subarray(0, options.maxBytes)), truncated: lines.length > options.maxLines || bytes.length > options.maxBytes };
}

async function collect(command: string, args: string[], limit: number) {
  const handle = start(command, args), chunks: Buffer[] = [];
  let bytes = 0, truncated = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void stop(handle); }, 20000);
  handle.child.stdout.on("data", (data: Buffer) => {
    if (bytes < limit) chunks.push(data.subarray(0, limit - bytes));
    bytes += data.length;
    if (bytes > limit && !truncated) { truncated = true; void stop(handle); }
  });
  try {
    const result = await handle.completed;
    if (timedOut) throw new DeckError("observation-timeout", "Device log read timed out. Request a shorter interval.", 504);
    if (result.code !== 0 && !truncated) throw new DeckError("observation-failed", "Device log read failed. Check the selected device and log capability.", 502);
    return { text: Buffer.concat(chunks).toString(), truncated };
  } finally { clearTimeout(timer); }
}

abstract class ObservationBase implements ObservationAdapter {
  abstract readonly capabilities: InteractionCapabilities;
  constructor(protected device: DeviceConfig, protected host: ObservationHost) {}
  async ui(_options: UiRead): Promise<UiSnapshot> { return unsupported("UI inspection"); }
  async logs(_options: DeviceLogs): Promise<{ text: string; truncated: boolean; since: string; until: string }> { return unsupported("device logs"); }
  async appState(_appId?: string): Promise<Record<string, unknown>> { return unsupported("app state"); }
  async launch(_appId: string, _args: string[]): Promise<unknown> { return unsupported("app launch"); }
  async close(): Promise<void> {}
}

class AppleSimulatorObservation extends ObservationBase {
  readonly capabilities: InteractionCapabilities = { backend: "idb", ui: true, logs: "history", appState: true, appLaunch: true, notes: ["UI bounds are simulator points. Gesture operations use their reported frame dimensions."] };
  private get udid() { return (this.device.connection as Extract<DeviceConfig["connection"], { type: "simulator" }>).udid; }
  async ui(options: UiRead) {
    await this.host.verify();
    const data = await this.host.execute(this.host.tool("idb"), ["ui", "describe-all", "--nested", "--json", "--udid", this.udid], 15000, { maxOutputBytes: 2 * 1024 * 1024 });
    return normalizeUi(JSON.parse(data.stdout.toString()), options, "points");
  }
  async logs(options: DeviceLogs) {
    await this.host.verify();
    const until = options.until || new Date().toISOString(), since = options.since || new Date(Date.parse(until) - 60000).toISOString();
    const date = (value: string) => new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+0000");
    const result = await collect("xcrun", ["simctl", "spawn", this.udid, "log", "show", "--start", date(since), "--end", date(until), "--style", "ndjson", ...(options.process ? ["--predicate", `process == ${JSON.stringify(options.process)}`] : [])], options.maxBytes);
    const bounded = boundedLogs(result.text, options);
    return { ...bounded, truncated: result.truncated || bounded.truncated, since, until };
  }
  async appState(appId?: string) {
    await this.host.verify();
    const output = (await this.host.execute(this.host.tool("idb"), ["list-apps", "--json", "--fetch-process-state", "--udid", this.udid])).stdout.toString();
    const apps = output.trim() ? output.trim().split(/\r?\n/).flatMap((line) => { const value = JSON.parse(line); return Array.isArray(value) ? value : [value]; }) : [];
    const selected = appId ? apps.filter((app: any) => (app.bundle_id ?? app.bundleId) === appId) : apps;
    return { apps: selected, ...(appId ? { appId, installed: selected.length > 0 } : {}) };
  }
  async launch(appId: string, args: string[]) {
    await this.host.verify();
    const result = await this.host.execute(this.host.tool("idb"), ["launch", "--foreground-if-running", "--udid", this.udid, appId, ...args]);
    return { appId, output: result.stdout.toString().trim() };
  }
}

class AndroidObservation extends ObservationBase {
  readonly capabilities: InteractionCapabilities = { backend: "adb-scrcpy", ui: true, logs: "history", appState: true, appLaunch: true, notes: ["UI values come from Android accessibility nodes; custom renderers may expose a partial tree."] };
  private async adb(args: string[]) { await this.host.verify(); return this.host.execute(this.host.tool("adb"), [...this.host.adb(), ...args], 15000, { maxOutputBytes: 2 * 1024 * 1024 }); }
  async ui(options: UiRead) {
    const result = await this.adb(["exec-out", "uiautomator", "dump", "/dev/tty"]);
    return normalizeUi(androidUi(result.stdout.toString()), options, "pixels");
  }
  async logs(options: DeviceLogs) {
    await this.host.verify();
    const until = options.until || new Date().toISOString(), since = options.since || new Date(Date.parse(until) - 60000).toISOString();
    const clock = async () => {
      const before = Date.now(), raw = (await this.adb(["shell", "date", "+%s"])).stdout.toString().trim(), after = Date.now();
      if (!/^\d+$/.test(raw)) throw new DeckError("device-clock-unavailable", "Android did not report a usable clock for bounded log collection.", 409);
      return { offsetMs: Number(raw) * 1000 + 500 - (before + after) / 2, uncertaintyMs: 500 + (after - before) / 2 };
    };
    const before = await clock();
    const result = await collect(this.host.tool("adb"), [...this.host.adb(), "exec-out", "logcat", "-d", "-v", "epoch", "-T", ((Date.parse(since) + before.offsetMs - before.uncertaintyMs) / 1000).toFixed(3), ...(options.process ? [`${options.process}:V`, "*:S"] : [])], options.maxBytes);
    const after = await clock();
    if (Math.abs(after.offsetMs - before.offsetMs) > before.uncertaintyMs + after.uncertaintyMs + 1000)
      throw new DeckError("device-clock-unstable", "Android clock changed during log collection. Retry the bounded read.", 409);
    const filtered = result.text.split(/\r?\n/).filter((line) => { const timestamp = /^\s*(\d+\.\d+)/.exec(line); const hostTime = timestamp ? Number(timestamp[1]) * 1000 - before.offsetMs : NaN; return hostTime >= Date.parse(since) && hostTime <= Date.parse(until); }).join("\n");
    const bounded = boundedLogs(filtered, options);
    return { ...bounded, truncated: result.truncated || bounded.truncated, since, until, clock: before };
  }
  async appState(appId?: string) {
    const activities = (await this.adb(["shell", "dumpsys", "activity", "activities"])).stdout.toString();
    const foregroundAppId = /(?:mResumedActivity|topResumedActivity|ResumedActivity)[^\n]*?\s([A-Za-z0-9_.]+)\//.exec(activities)?.[1] || null;
    return { foregroundAppId, ...(appId ? { appId, foreground: foregroundAppId === null ? null : foregroundAppId === appId } : {}) };
  }
  async launch(appId: string, args: string[]) {
    if (args.length) return unsupported("Android app launch arguments");
    let resolved = "";
    for (const category of ["android.intent.category.LAUNCHER", "android.intent.category.LEANBACK_LAUNCHER"]) {
      resolved = (await this.adb(["shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", category, appId])).stdout.toString().trim().split(/\r?\n/).at(-1)!;
      if (/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(resolved)) break;
    }
    if (!/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(resolved) || resolved.split("/")[0] !== appId) throw new DeckError("app-unavailable", "No launcher activity was found for the requested installed app.", 409);
    const result = await this.adb(["shell", "am", "start", "-W", "-n", `'${resolved}'`]);
    if (/^\s*(?:Error(?: type \d+)?:|(?:[\w$]+\.)*\w*Exception\b|Status:\s*(?!ok\b)\w+)/im.test(`${result.stdout}\n${result.stderr}`)) throw new DeckError("app-launch-failed", "Android could not launch the requested app.", 502);
    return { appId, activity: resolved };
  }
}

class PhysicalAppleObservation extends ObservationBase {
  private pending?: InteractiveSource;
  readonly capabilities: InteractionCapabilities = { backend: "webdriveragent", ui: true, logs: false, appState: true, appLaunch: true, notes: ["Signed WebDriverAgent and USB are required. Close touch control before launching an app. Historical device logs are unsupported."] };
  private async read(method: string, route: string, body?: unknown) {
    const connection = await this.host.wda();
    try { return (await connection.request(method, route, body)).value; }
    finally { await connection.close(); }
  }
  async ui(options: UiRead) { return normalizeUi(await this.read("GET", "/source?format=json"), options, "points"); }
  async appState(appId?: string) {
    const info: any = await this.read("GET", "/wda/activeAppInfo");
    return { foregroundAppId: info.bundleId ?? null, pid: info.pid ?? null, ...(appId ? { appId, foreground: info.bundleId ? info.bundleId === appId : null } : {}) };
  }
  async launch(appId: string, args: string[]) {
    await this.close();
    const connection = await this.host.wda();
    const source = await startWdaInteractive(connection, () => this.host.wda(), (id) => this.host.ownership?.opened(id));
    this.pending = source;
    try {
      await connection.request("POST", `/session/${encodeURIComponent(source.sessionId)}/wda/apps/launch`, { bundleId: appId, arguments: args, shouldWaitForQuiescence: false });
      return { appId };
    } finally { await this.close(); }
  }
  async close() {
    const source = this.pending;
    if (!source) return;
    await source.close();
    this.host.ownership?.closed();
    if (this.pending === source) this.pending = undefined;
  }
}

class RokuObservation extends ObservationBase {
  readonly capabilities: InteractionCapabilities = { backend: "roku-ecp", ui: false, logs: "live", appState: true, appLaunch: true, notes: ["UI trees are unsupported. Logs capture new developer-console output only; developer mode must be enabled."] };
  private get hostName() { return (this.device.connection as Extract<DeviceConfig["connection"], { type: "roku" }>).host; }
  private async request(route: string, method = "GET") {
    await this.host.verify();
    const result = await fetch(`http://${this.hostName}:8060${route}`, { method, redirect: "error", signal: AbortSignal.timeout(5000), ...(method === "POST" ? { body: "", headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}) });
    if (!result.ok) throw new DeckError("observation-failed", `Roku returned HTTP ${result.status}.`, 502);
    return result.text();
  }
  async appState(appId?: string) {
    const xml = await this.request("/query/active-app");
    const app = /<app\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)<\/app>/.exec(xml);
    return { foregroundAppId: app ? decode(app[1]) : null, name: app ? decode(app[2]) : null, ...(appId ? { appId, foreground: app ? decode(app[1]) === appId : null } : {}) };
  }
  async launch(appId: string, args: string[]) {
    if (args.length) return unsupported("Roku app launch arguments");
    await this.request(`/launch/${encodeURIComponent(appId)}`, "POST"); return { appId };
  }
  async logs(options: DeviceLogs) {
    if (options.since || options.until || options.process) return unsupported("historical or filtered Roku logs; use a bounded live read");
    await this.host.verify();
    const since = new Date().toISOString();
    const result = await new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
      const socket = createConnection({ host: this.hostName, port: 8085 });
      const chunks: Buffer[] = []; let size = 0, done = false, connected = false;
      const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve({ text: Buffer.concat(chunks).toString(), truncated: size > options.maxBytes }); };
      const timer = setTimeout(() => finish(connected ? undefined : new DeckError("device-logs-unavailable", "Roku developer console did not connect within the requested interval.", 409)), options.durationMs);
      socket.on("connect", () => { connected = true; });
      socket.on("error", () => finish(new DeckError("device-logs-unavailable", "Roku developer console is unavailable on the selected device.", 409)));
      socket.on("data", (data: Buffer) => { if (size < options.maxBytes) chunks.push(data.subarray(0, options.maxBytes - size)); size += data.length; if (size > options.maxBytes) finish(); });
      socket.on("close", () => finish());
    });
    const bounded = boundedLogs(result.text, options);
    return { ...bounded, truncated: result.truncated || bounded.truncated, since, until: new Date().toISOString() };
  }
}

class UnsupportedObservation extends ObservationBase {
  readonly capabilities: InteractionCapabilities;
  constructor(device: DeviceConfig, host: ObservationHost) {
    super(device, host);
    this.capabilities = { backend: device.connection.type === "apple-tv" ? "apple-tv-companion" : "capture-only", ui: false, logs: false, appState: false, appLaunch: false, notes: ["This transport provides no structured app observations; use its advertised input and capture capabilities."] };
  }
}
export function observationAdapter(device: DeviceConfig, host: ObservationHost): ObservationAdapter {
  switch (device.connection.type) {
    case "simulator": return new AppleSimulatorObservation(device, host);
    case "adb": return new AndroidObservation(device, host);
    case "roku": return new RokuObservation(device, host);
    case "apple-device": return device.connection.webDriverAgent ? new PhysicalAppleObservation(device, host) : new UnsupportedObservation(device, host);
    default: return new UnsupportedObservation(device, host);
  }
}
