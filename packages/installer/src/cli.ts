#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { installerTrust } from "./trust";
import { install, installedEntry } from "./index";
const args = process.argv.slice(2);
try {
  if (!installerTrust)
    throw new Error(
      "Private installer scaffold: signed release trust and Keygen product setup are pending. No download or license mock is available.",
    );
  const directory = path.join(
    os.homedir(),
    "Library/Application Support/Device Deck App",
  );
  if (args[0] === "install") {
    if (args.length !== 3)
      throw new Error(
        "Use devdeck install <signed-release.json> <private-license-key-file>. New users need issuer onboarding before protected downloads.",
      );
    const target = await install(
      JSON.parse(await readFile(args[1], "utf8")),
      installerTrust,
      (await readFile(args[2], "utf8")).trim(),
      directory,
    );
    console.log(
      `Installed ${target}. Existing running daemons were left unchanged.`,
    );
  } else {
    const entry = await installedEntry(directory, installerTrust);
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: "inherit",
    });
    child.on("error", (e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code || 0;
    });
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
