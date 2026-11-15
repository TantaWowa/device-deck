import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const sharedServiceDirectory = "/Library/Application Support/Device Deck";
export const sharedHostSchema = z.object({
  schemaVersion: z.literal(1),
  uid: z.number().int().min(1),
  username: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  home: z.string().refine(path.isAbsolute),
  profile: z.string().refine(path.isAbsolute),
}).strict();
export type SharedHost = z.infer<typeof sharedHostSchema>;
export const accountEndpointSchema = z.object({
  schemaVersion: z.literal(1), hostUID: z.number().int().min(1),
  uid: z.number().int().min(1), grantId: z.string().uuid(),
  port: z.number().int().min(1).max(65535), pid: z.number().int().min(2),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), startedAt: z.number(),
}).strict();

export async function assertOwnedDirectory(directory: string, uid: number) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022))
    throw new Error("Device Deck's shared service directory has unsafe ownership or permissions. Repair it using Mac setup.");
}

async function readOwnedJSON(file: string, uid: number, privateFile = false) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & (privateFile ? 0o077 : 0o022)))
      throw new Error("Device Deck's shared access file has unsafe ownership or permissions. Repair it using Mac setup.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

/** The installer owns this marker. A regular local account cannot redirect clients. */
export async function readSharedHost(directory = sharedServiceDirectory, rootUID = 0): Promise<SharedHost | undefined> {
  try { await lstat(path.join(directory, "host.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await assertOwnedDirectory(directory, rootUID);
  return sharedHostSchema.parse(await readOwnedJSON(path.join(directory, "host.json"), rootUID));
}

export async function readAccountEndpoint(host: SharedHost, uid = process.getuid!(), directory = sharedServiceDirectory) {
  await assertOwnedDirectory(path.join(directory, "access"), host.uid);
  try {
    const endpoint = accountEndpointSchema.parse(await readOwnedJSON(path.join(directory, "access", `${uid}.json`), host.uid, true));
    if (endpoint.hostUID !== host.uid || endpoint.uid !== uid) throw new Error("Device Deck's shared account identity does not match this Mac account.");
    return { ...endpoint, shared: true as const };
  } catch (error) {
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code || ""))
      throw new Error(`Ask ${host.username} to allow this Mac account in Device Deck setup. The shared service may also be starting.`);
    throw error;
  }
}

export function hasExplicitProfile(environment = process.env) {
  return Boolean(environment.DEVICE_DECK_HOME || environment.DEVICE_DECK_CONFIG);
}
