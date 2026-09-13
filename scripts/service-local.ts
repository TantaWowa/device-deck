import path from "node:path";
import { root } from "../packages/adapters/src";
import { LocalDevelopmentLicense } from "./local-license";
import { runDaemon } from "../apps/daemon/src/run";

process.env.DEVICE_DECK_HOME ??= path.join(root, "work/local-deck");
console.error(
  "Device Deck: local development activation mock enabled; real capture hardware.",
);
await runDaemon(new LocalDevelopmentLicense());
