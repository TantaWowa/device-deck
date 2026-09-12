import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { ConfigStore } from "../packages/config/src";
const root = process.cwd();
const udid = (await readFile("work/proof-udid.txt", "utf8")).trim();
const dir = path.join(root, "work/proof-home");
await mkdir(dir, { recursive: true });
const store = new ConfigStore(path.join(dir, "config.json"));
await store.load();
const c = store.config;
c.port = 0;
c.tools.idb = path.join(root, "work/idb-venv/bin/idb");
c.settings.folder = path.join(root, "work/proof-captures");
c.devices = [
  {
    id: "proof-ios",
    name: "Device Deck Proof",
    platform: "Apple",
    kind: "virtual",
    model: "iPhone 15 Pro · iOS 26.3",
    visibility: "local",
    connection: { type: "simulator", udid, os: "ios" },
    captureSourceId: "proof-screen",
  },
];
c.sources = [
  {
    id: "proof-screen",
    name: "Proof simulator native screen",
    kind: "native",
    deviceId: "proof-ios",
  },
];
await store.save(c, store.revision);
console.log("Isolated proof configuration prepared.");
