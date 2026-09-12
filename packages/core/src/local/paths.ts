import os from "node:os";
import path from "node:path";
export const dataDirectory = () =>
  path.resolve(
    process.env.DEVICE_DECK_HOME ||
      path.join(os.homedir(), "Library/Application Support/Device Deck"),
  );
