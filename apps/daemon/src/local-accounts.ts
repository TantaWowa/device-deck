import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, SerialQueue } from "../../../packages/config/src";
import { assertOwnedDirectory, sharedServiceDirectory, type SharedHost } from "../../../packages/core/src/shared-host";
import { DeckError } from "../../../packages/core/src/local/types";

const exec = promisify(execFile);
const grantSchema = z.object({ id: z.string().uuid(), uid: z.number().int().min(1), username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/), hash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number() }).strict();
const stateSchema = z.object({ grants: z.array(grantSchema) }).strict();
export type LocalAccountGrant = Omit<z.infer<typeof grantSchema>, "hash">;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
type Endpoint = { port: number; pid: number; startedAt: number };
type CredentialWriter = (uid: number, value: unknown, username: string) => Promise<void>;
type AccountDirectory = () => Promise<{ uid: number; username: string }[]>;
class MissingMacAccount extends Error {}

export async function localMacUsers() {
  const { stdout } = await exec("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"]);
  return stdout.split("\n").flatMap(line => {
    const match = /^(\S+)\s+(\d+)\s*$/.exec(line);
    return match && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(match[1]) && Number(match[2]) >= 500 && !match[1].startsWith("_")
      ? [{ username: match[1], uid: Number(match[2]) }] : [];
  }).sort((a, b) => a.username.localeCompare(b.username));
}

/** One private host profile owns all device locks. Other accounts receive revocable API credentials. */
export class LocalAccounts {
  private readonly file: string;
  private readonly queue = new SerialQueue();
  private endpoint?: Endpoint;
  private readonly accessDirectory: string;
  private readonly users: AccountDirectory;
  constructor(directory: string, readonly host?: SharedHost, options: { directory?: string; writeCredential?: CredentialWriter; users?: AccountDirectory } = {}) {
    this.file = path.join(directory, "local-accounts.json");
    this.accessDirectory = path.join(options.directory || sharedServiceDirectory, "access");
    this.writeCredential = options.writeCredential || this.writeCredential;
    this.users = options.users || localMacUsers;
  }
  private async read() {
    try { return stateSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { grants: [] };
      throw new DeckError("shared-access-invalid", "Mac account access could not be read. Repair sharing in Device Deck setup.", 503);
    }
  }
  private summary({ hash: _hash, ...grant }: z.infer<typeof grantSchema>): LocalAccountGrant { return grant; }
  async list() { return { enabled: Boolean(this.host), host: this.host && { uid: this.host.uid, username: this.host.username }, grants: (await this.read()).grants.map(g => this.summary(g)) }; }
  async authorize(token: string): Promise<LocalAccountGrant | undefined> {
    if (!this.host || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const hash = Buffer.from(digest(token), "hex");
    const grant = (await this.read()).grants.find(g => timingSafeEqual(hash, Buffer.from(g.hash, "hex")));
    return grant && this.summary(grant);
  }
  async active(id: string) { return Boolean(this.host && (await this.read()).grants.some(g => g.id === id)); }
  async start(endpoint: Endpoint) {
    if (!this.host) return;
    this.endpoint = endpoint;
    await this.queue.run(async () => {
      const state = await this.read();
      const users = state.grants.length ? await this.users() : [];
      const stale = state.grants.filter(grant => !users.some(user => user.uid === grant.uid && user.username === grant.username));
      if (stale.length) {
        const staleIDs = new Set(stale.map(grant => grant.id));
        state.grants = state.grants.filter(grant => !staleIDs.has(grant.id));
        // Persist revocation before rotating surviving accounts or exposing
        // their new endpoints. A reused username or UID gets no prior access.
        await atomicWrite(this.file, JSON.stringify(state));
        for (const grant of stale) await rm(path.join(this.accessDirectory, `${grant.uid}.json`), { force: true });
      }
      const retained: typeof state.grants = [];
      for (const grant of state.grants) {
        const token = randomBytes(32).toString("base64url");
        // Rotate both credentials and grant IDs. Old browser sessions cannot
        // regain access after an account is revoked and later added again.
        grant.id = randomUUID();
        grant.hash = digest(token);
        try {
          await this.writeCredential(grant.uid, { schemaVersion: 1, hostUID: this.host!.uid, uid: grant.uid, grantId: grant.id, token, ...endpoint }, grant.username);
          retained.push(grant);
        } catch (error) {
          if (!(error instanceof MissingMacAccount)) throw error;
          await rm(path.join(this.accessDirectory, `${grant.uid}.json`), { force: true });
        }
      }
      state.grants = retained;
      await atomicWrite(this.file, JSON.stringify(state));
    });
  }
  grant(account: { uid: number; username: string }) {
    return this.queue.run(async () => {
      if (!this.host || !this.endpoint) throw new DeckError("sharing-disabled", "Enable the shared Mac service in Device Deck setup first.", 409);
      if (account.uid === this.host.uid) throw new DeckError("host-already-authorized", "The hosting account already has access.", 400);
      const state = await this.read();
      const token = randomBytes(32).toString("base64url");
      const grant = grantSchema.parse({ ...account, id: randomUUID(), hash: digest(token), createdAt: Date.now() });
      state.grants = state.grants.filter(g => g.uid !== account.uid);
      state.grants.push(grant);
      await this.writeCredential(grant.uid, { schemaVersion: 1, hostUID: this.host.uid, uid: grant.uid, grantId: grant.id, token, ...this.endpoint }, grant.username);
      await atomicWrite(this.file, JSON.stringify(state));
      return this.summary(grant);
    });
  }
  revoke(uid: number) {
    return this.queue.run(async () => {
      z.number().int().min(1).parse(uid);
      const state = await this.read();
      state.grants = state.grants.filter(g => g.uid !== uid);
      // Revoke on the server before removing the client's cached credential.
      await atomicWrite(this.file, JSON.stringify(state));
      await rm(path.join(this.accessDirectory, `${uid}.json`), { force: true });
      return { ok: true };
    });
  }
  private writeCredential: CredentialWriter = async (uid, value, username) => {
    await assertOwnedDirectory(this.accessDirectory, this.host!.uid);
    let actualUID: number;
    try { actualUID = Number((await exec("/usr/bin/id", ["-u", username])).stdout.trim()); }
    catch (error) {
      // A disappearing directory entry is recoverable. Failure to query an
      // existing account, or any subsequent file/ACL operation, is not.
      if ((await this.users()).some(user => user.uid === uid && user.username === username)) throw error;
      throw new MissingMacAccount("This Mac account no longer exists. Choose an existing account in Device Deck setup.");
    }
    if (actualUID !== uid) throw new MissingMacAccount("The Mac account changed. Remove and add it again in Device Deck setup.");
    const target = path.join(this.accessDirectory, `${uid}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
    try {
      // Grant read access only. Apply before rename so no reader can observe a
      // partly written credential, and permissions survive endpoint rotation.
      await exec("/bin/chmod", ["+a", `user:${username} allow read,readattr,readextattr,readsecurity`, temporary]);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  };
}
