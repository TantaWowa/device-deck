import { mkdir, lstat, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(homedir(), ".local", "bin");
const launcher = path.join(root, "devdeck");
const target = path.join(directory, "devdeck");
await mkdir(directory, { recursive: true });
const existing = await lstat(target).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
if (existing) {
  if (
    !existing.isSymbolicLink() ||
    (await realpath(target).catch(() => "")) !== launcher
  )
    throw new Error(
      `${target} already exists. Keep or move that installation before installing this development launcher.`,
    );
} else await symlink(launcher, target);
console.log(
  `Development CLI installed: ${target}\nUses this checkout and its local development profile.`,
);
if (!process.env.PATH?.split(path.delimiter).includes(directory))
  console.log(
    `Add ${directory} to PATH in your shell configuration, then reopen your terminal.`,
  );
