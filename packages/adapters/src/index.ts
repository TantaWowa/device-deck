// Adapted from Tawi discovery, Hosanna Tools Roku SSDP, and George Cook's tv-remote.py.
// See docs/source-provenance.md. No personal checkout is a runtime dependency.
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { run, available, start, stop } from "./process";
import {
  type Config,
  type DeviceConfig,
  type Device,
  type Source,
  type SourceConfig,
  fail,
} from "../../core/src/local/types";
let location = path.dirname(fileURLToPath(import.meta.url));
while (
  !existsSync(path.join(location, "native/apple-tv.py")) &&
  path.dirname(location) !== location
)
  location = path.dirname(location);
export const root = location;
export const helper = path.join(root, "build/native/deck-camera");
const uid = (prefix: string, value: string) =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const androidKeys: Record<string, string> = {
  Up: "DPAD_UP",
  Down: "DPAD_DOWN",
  Left: "DPAD_LEFT",
  Right: "DPAD_RIGHT",
  OK: "DPAD_CENTER",
  Select: "DPAD_CENTER",
  Back: "BACK",
  Home: "HOME",
  Menu: "MENU",
  Play: "MEDIA_PLAY_PAUSE",
  "Play / pause": "MEDIA_PLAY_PAUSE",
  Backspace: "DEL",
  VolumeUp: "VOLUME_UP",
  VolumeDown: "VOLUME_DOWN",
};
const rokuKeys: Record<string, string> = {
  ...Object.fromEntries(
    [
      "Up",
      "Down",
      "Left",
      "Right",
      "Back",
      "Home",
      "Play",
      "Backspace",
      "VolumeUp",
      "VolumeDown",
    ].map((k) => [k, k]),
  ),
  OK: "Select",
  Select: "Select",
  Menu: "Info",
  "Play / pause": "Play",
};
const hidKeys: Record<string, string> = {
  Up: "82",
  Down: "81",
  Left: "80",
  Right: "79",
  OK: "40",
  Select: "40",
  Back: "41",
  Backspace: "42",
  Play: "44",
  "Play / pause": "44",
};
export type Discovery = {
  devices: DeviceConfig[];
  sources: SourceConfig[];
  diagnostics: string[];
};
export class Adapters {
  constructor(private getConfig: () => Config) {}
  tool(name: keyof Config["tools"]) {
    return (
      this.getConfig().tools[name] || (name === "python" ? "python3" : name)
    );
  }
  adb(d: DeviceConfig) {
    if (d.connection.type !== "adb") return [];
    return ["-P", String(d.connection.port), "-s", d.connection.serial];
  }
  async diagnostics() {
    return (
      await Promise.all(
        ["adb", "ffmpeg", "ffprobe", "idb"].map(async (n) =>
          (await available(this.tool(n as keyof Config["tools"])))
            ? ""
            : `${n} not found; its capabilities are unavailable.`,
        ),
      )
    ).filter(Boolean);
  }
  async discover(): Promise<Discovery> {
    const devices: DeviceConfig[] = [],
      sources: SourceConfig[] = [],
      diagnostics: string[] = [];
    const safe = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        diagnostics.push(`${name}: ${(e as Error).message}`);
      }
    };
    await Promise.all([
      safe("Android", async () => {
        if (!(await available(this.tool("adb")))) return;
        for (const port of [
          ...new Set([
            5037,
            ...this.getConfig().devices.flatMap((d) =>
              d.connection.type === "adb" ? [d.connection.port] : [],
            ),
          ]),
        ]) {
          const { stdout } = await run(this.tool("adb"), [
            "-P",
            String(port),
            "devices",
            "-l",
          ]);
          for (const line of stdout.toString().split("\n").slice(1)) {
            const [serial, state, ...parts] = line.trim().split(/\s+/);
            if (
              !serial ||
              !["device", "offline", "unauthorized"].includes(state)
            )
              continue;
            const model =
              parts.find((p) => p.startsWith("model:"))?.slice(6) || serial;
            let hardwareId: string | undefined;
            if (state === "device" && !serial.startsWith("emulator-")) {
              hardwareId =
                (
                  await run(this.tool("adb"), [
                    "-P",
                    String(port),
                    "-s",
                    serial,
                    "shell",
                    "getprop",
                    "ro.serialno",
                  ]).catch(() => ({ stdout: Buffer.from("") }))
                ).stdout
                  .toString()
                  .trim() || undefined;
            }
            const id = uid("adb", hardwareId || serial),
              nativeId = `native-${id}`;
            if (devices.some((d) => d.id === id)) continue;
            devices.push({
              id,
              name: model,
              model,
              platform: "Android",
              kind: serial.startsWith("emulator-") ? "virtual" : "physical",
              visibility: "local",
              connection: {
                type: "adb",
                serial,
                port,
                ...(hardwareId ? { hardwareId } : {}),
              },
              captureSourceId: nativeId,
            });
            sources.push({
              id: nativeId,
              name: `${model} native screen`,
              kind: "native",
              deviceId: id,
            });
          }
        }
      }),
      safe("Simulators", async () => {
        const result = await run("xcrun", [
          "simctl",
          "list",
          "devices",
          "available",
          "--json",
        ]);
        const data = JSON.parse(result.stdout.toString());
        for (const [runtime, list] of Object.entries(data.devices || {})) {
          if (!/iOS|tvOS/.test(runtime)) continue;
          for (const d of list as { udid: string; name: string }[]) {
            const id = uid("sim", d.udid),
              sourceId = `native-${id}`;
            devices.push({
              id,
              name: d.name,
              model: runtime.split(".").at(-1) || "",
              platform: "Apple",
              kind: "virtual",
              visibility: "local",
              connection: {
                type: "simulator",
                udid: d.udid,
                os: /tvOS/.test(runtime) ? "tvos" : "ios",
              },
              captureSourceId: sourceId,
            });
            sources.push({
              id: sourceId,
              name: `${d.name} native screen`,
              kind: "native",
              deviceId: id,
            });
          }
        }
      }),
      safe("Apple devices", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "deck-discovery-"));
        try {
          const file = path.join(dir, "devices.json");
          await run("xcrun", [
            "devicectl",
            "list",
            "devices",
            "--json-output",
            file,
            "--quiet",
          ]);
          const data = JSON.parse(await readFile(file, "utf8"));
          for (const d of data.result?.devices || [])
            devices.push({
              id: uid("apple", d.identifier),
              name: d.deviceProperties?.name || "Apple device",
              model: d.hardwareProperties?.marketingName || "",
              platform: "Apple",
              kind: "physical",
              visibility: "local",
              connection: { type: "apple-device", udid: d.identifier },
              captureSourceId: null,
            });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      safe("USB capture", async () => {
        const result = await run(helper, ["list"]);
        for (const s of JSON.parse(result.stdout.toString()))
          sources.push({
            id: uid("usb", s.uniqueId),
            name: s.name,
            kind: "usb",
            uniqueId: s.uniqueId,
          });
      }),
      safe("Roku", async () => {
        for (const host of await this.scanRoku()) {
          try {
            const info = await this.rokuInfo(host);
            if (!info.serial) continue;
            devices.push({
              id: uid("roku", info.serial),
              name: info.name,
              model: info.model,
              platform: "Roku",
              kind: "physical",
              visibility: "local",
              connection: { type: "roku", host, serial: info.serial },
              captureSourceId: null,
            });
          } catch {}
        }
      }),
      safe("Apple TV", async () => {
        if (!(await available(this.tool("python")))) return;
        const r = await run(
          this.tool("python"),
          [path.join(root, "native/apple-tv.py"), "scan"],
          10000,
        );
        for (const d of JSON.parse(r.stdout.toString()))
          devices.push({
            id: uid("atv", d.identifier),
            name: d.name,
            model: "Apple TV · Companion",
            platform: "Apple",
            kind: "physical",
            visibility: "local",
            connection: {
              type: "apple-tv",
              host: d.host,
              identifier: d.identifier,
            },
            captureSourceId: null,
          });
      }),
    ]);
    return { devices, sources, diagnostics };
  }
  async inspectSources(configs: SourceConfig[]): Promise<Source[]> {
    let list: { uniqueId: string; inUse: string }[] = [];
    try {
      list = JSON.parse((await run(helper, ["list"])).stdout.toString());
    } catch {}
    return configs.map((s) =>
      s.kind === "native"
        ? { ...s, status: "connected" }
        : {
            ...s,
            status: list.some((x) => x.uniqueId === s.uniqueId)
              ? "connected"
              : "missing",
            detail:
              list.find((x) => x.uniqueId === s.uniqueId)?.inUse === "true"
                ? "In use by another application"
                : undefined,
          },
    );
  }
  async inspect(d: DeviceConfig): Promise<Device> {
    const result: Device = {
      ...d,
      online: false,
      healthDetail: "Not connected",
      locked: false,
      capabilities: [],
    };
    const c = d.connection;
    try {
      if (c.type === "adb") {
        await this.verifyIdentity(d);
        const { stdout } = await run(this.tool("adb"), [
          ...this.adb(d),
          "get-state",
        ]);
        result.online = stdout.toString().trim() === "device";
        if (result.online) result.capabilities.push("key", "text", "restart");
      }
      if (c.type === "roku") {
        const info = await this.rokuInfo(c.host);
        if (info.serial !== c.serial)
          fail(
            "identity-mismatch",
            "Roku at this address has a different serial number.",
          );
        result.online = true;
        result.capabilities.push("key", "text");
      }
      if (c.type === "simulator") {
        const data = JSON.parse(
          (
            await run("xcrun", [
              "simctl",
              "list",
              "devices",
              "available",
              "--json",
            ])
          ).stdout.toString(),
        );
        result.online = Object.values(data.devices || {})
          .flat()
          .some((x: any) => x.udid === c.udid && x.state === "Booted");
        if (result.online) {
          result.capabilities.push("restart");
          if (
            (await available(this.tool("idb"))) &&
            (await available("idb_companion"))
          )
            result.capabilities.push("key", "text");
        }
      }
      if (c.type === "apple-tv") {
        const info = JSON.parse(
          (
            await run(this.tool("python"), [
              path.join(root, "native/apple-tv.py"),
              "inspect",
              c.host,
              c.identifier,
            ])
          ).stdout.toString(),
        );
        result.online = true;
        if (info.paired) result.capabilities.push("key", "text");
        else result.healthDetail = "Pair Companion using devdeck apple-pair";
      }
      if (c.type === "apple-device") {
        const dir = await mkdtemp(path.join(os.tmpdir(), "deck-device-"));
        try {
          const file = path.join(dir, "d.json");
          await run("xcrun", [
            "devicectl",
            "list",
            "devices",
            "--json-output",
            file,
            "--quiet",
          ]);
          const list =
            JSON.parse(await readFile(file, "utf8")).result?.devices || [];
          result.online = list.some(
            (x: any) =>
              x.identifier === c.udid &&
              ["connected", "available"].includes(
                x.connectionProperties?.tunnelState ||
                  x.deviceProperties?.connectionState,
              ),
          );
          result.healthDetail =
            "Discovery only; native input/capture not supported by this adapter.";
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      const source = this.getConfig().sources.find(
        (s) => s.id === d.captureSourceId,
      );
      if (
        result.online &&
        source &&
        (source.kind === "usb" || ["adb", "simulator"].includes(c.type))
      ) {
        result.capabilities.push("preview", "screenshot");
        if (
          (await available(this.tool("ffmpeg"))) &&
          (await available(this.tool("ffprobe")))
        )
          result.capabilities.push("record");
      }
      if (result.online && result.healthDetail === "Not connected")
        result.healthDetail = "Connected";
    } catch (e) {
      result.healthDetail = (e as Error).message;
    }
    return result;
  }
  async verifyIdentity(d: DeviceConfig) {
    if (d.connection.type === "adb" && d.connection.hardwareId) {
      const serial = (
        await run(this.tool("adb"), [
          ...this.adb(d),
          "shell",
          "getprop",
          "ro.serialno",
        ])
      ).stdout
        .toString()
        .trim();
      if (serial !== d.connection.hardwareId)
        fail(
          "identity-mismatch",
          "The Android device at this transport has a different hardware serial.",
          409,
        );
    }
  }
  async input(
    d: DeviceConfig,
    input: { key?: string; text?: string; x?: number; y?: number },
  ) {
    const c = d.connection;
    if (c.type === "adb") {
      await this.verifyIdentity(d);
      if (input.x !== undefined && input.y !== undefined) {
        await run(this.tool("adb"), [
          ...this.adb(d),
          "shell",
          "input",
          "tap",
          String(Math.round(input.x)),
          String(Math.round(input.y)),
        ]);
        return;
      }
      if (input.text !== undefined) {
        if (/[^\x20-\x7e]/.test(input.text))
          fail("unsupported-text", "ADB text supports printable ASCII.");
        for (const [index, part] of input.text.split("%").entries()) {
          if (index)
            await run(this.tool("adb"), [
              ...this.adb(d),
              "shell",
              "input",
              "text",
              "'%'",
            ]);
          if (part)
            await run(this.tool("adb"), [
              ...this.adb(d),
              "shell",
              "input",
              "text",
              shellQuote(part.replaceAll(" ", "%s")),
            ]);
        }
        return;
      }
      const key = androidKeys[input.key || ""];
      if (!key) fail("unsupported-key", "Unsupported Android key.");
      await run(this.tool("adb"), [
        ...this.adb(d),
        "shell",
        "input",
        "keyevent",
        `KEYCODE_${key}`,
      ]);
      return;
    }
    if (c.type === "roku") {
      const info = await this.rokuInfo(c.host);
      if (info.serial !== c.serial)
        fail("identity-mismatch", "Roku serial changed.");
      const keys =
        input.text !== undefined
          ? [...input.text].map((t) => `Lit_${t}`)
          : [rokuKeys[input.key || ""]];
      if (keys.some((k) => !k))
        fail("unsupported-key", "Unsupported Roku key.");
      for (const key of keys) {
        const r = await fetch(
          `http://${c.host}:8060/keypress/${encodeURIComponent(key)}`,
          {
            method: "POST",
            signal: AbortSignal.timeout(5000),
            redirect: "error",
          },
        );
        if (!r.ok) fail("input-failed", `Roku returned ${r.status}`, 502);
      }
      return;
    }
    if (c.type === "simulator") {
      const args = ["--udid", c.udid];
      if (input.text !== undefined)
        await run(this.tool("idb"), ["ui", "text", input.text, ...args]);
      else if (input.x !== undefined && input.y !== undefined)
        await run(this.tool("idb"), [
          "ui",
          "tap",
          String(input.x),
          String(input.y),
          ...args,
        ]);
      else if (input.key === "Home")
        await run(this.tool("idb"), ["ui", "button", "HOME", ...args]);
      else {
        const key = hidKeys[input.key || ""];
        if (!key) fail("unsupported-key", "Unsupported simulator key.");
        await run(this.tool("idb"), ["ui", "key", key, ...args]);
      }
      return;
    }
    if (c.type === "apple-tv") {
      await run(
        this.tool("python"),
        [
          path.join(root, "native/apple-tv.py"),
          input.text !== undefined ? "text" : "key",
          c.host,
          c.identifier,
          input.text ?? input.key ?? "",
        ],
        25000,
      );
      return;
    }
    fail(
      "unsupported-capability",
      "Remote input is not available for this device.",
    );
  }
  async pair(d: DeviceConfig) {
    if (d.connection.type !== "apple-tv")
      fail(
        "unsupported-pairing",
        "PIN pairing is available for Apple TV Companion.",
      );
    const handle = start(this.tool("python"), [
      path.join(root, "native/apple-tv.py"),
      "pair",
      d.connection.host,
      d.connection.identifier,
    ]);
    for (let i = 0; i < 200; i++) {
      if (handle.exited())
        fail("pairing-failed", handle.log() || handle.output(), 502);
      if (handle.output().includes("PIN shown on Apple TV:")) return handle;
      await new Promise((r) => setTimeout(r, 100));
    }
    await stop(handle);
    fail("pairing-timeout", "Apple TV did not show a pairing PIN.", 504);
  }
  async screenshot(d: DeviceConfig) {
    await this.verifyIdentity(d);
    if (d.connection.type === "adb")
      return (
        await run(this.tool("adb"), [
          ...this.adb(d),
          "exec-out",
          "screencap",
          "-p",
        ])
      ).stdout;
    if (d.connection.type === "simulator")
      return (
        await run("xcrun", [
          "simctl",
          "io",
          d.connection.udid,
          "screenshot",
          "--type=png",
          ...(d.connection.os === "tvos" ? ["--display=external"] : []),
          "-",
        ])
      ).stdout;
    fail(
      "unsupported-capability",
      "Configure a USB capture input for this device.",
    );
  }
  async restart(d: DeviceConfig) {
    if (d.connection.type === "adb") {
      await this.verifyIdentity(d);
      await run(this.tool("adb"), [...this.adb(d), "reboot"]);
      return;
    }
    if (d.connection.type === "simulator") {
      await run("xcrun", ["simctl", "shutdown", d.connection.udid]);
      await run("xcrun", ["simctl", "boot", d.connection.udid]);
      await run(
        "xcrun",
        ["simctl", "bootstatus", d.connection.udid, "-b"],
        120000,
      );
      return;
    }
    fail("unsupported-capability", "Restart is not supported for this device.");
  }
  private async rokuInfo(host: string) {
    const r = await fetch(`http://${host}:8060/query/device-info`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!r.ok) fail("device-offline", `Roku returned ${r.status}`);
    const text = await r.text();
    const tag = (name: string) =>
      new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1] || "";
    return {
      name: tag("friendly-device-name") || tag("model-name") || "Roku",
      model: tag("model-name"),
      serial: tag("serial-number"),
    };
  }
  private scanRoku(): Promise<string[]> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");
      const hosts = new Set<string>();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          socket.close();
        } catch {}
        resolve([...hosts]);
      };
      const timer = setTimeout(finish, 2000);
      socket.on("error", () => {
        clearTimeout(timer);
        finish();
      });
      socket.on("message", (m, remote) => {
        if (/st:\s*roku:ecp/i.test(m.toString())) hosts.add(remote.address);
      });
      socket.bind(() =>
        socket.send(
          'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: roku:ecp\r\n\r\n',
          1900,
          "239.255.255.250",
        ),
      );
    });
  }
}
