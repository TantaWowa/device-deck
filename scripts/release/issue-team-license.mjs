import { mkdir, readFile, chmod, open, rm } from "node:fs/promises";
import { isFutureExpiry, writePrivateFile } from "./operator-files.mjs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Keygen, relation } from "./keygen.mjs";

const { values } = parseArgs({ options: {
  members: { type: "string" }, mode: { type: "string", default: "test" },
  days: { type: "string", default: "60" }, campaign: { type: "string", default: "team-beta-2026" },
  apply: { type: "boolean", default: false }, help: { type: "boolean" },
} });
if (values.help || !values.members) {
  console.log("Issue complimentary Device Deck Pro licenses without sending email.\nUsage: npm run release:team-license -- --members work/release-secrets/team.json [--mode test|live] [--days 60] [--campaign team-beta-2026] [--apply]\nMembers file: [{\"email\":\"person@example.com\",\"firstName\":\"Person\",\"lastName\":\"Name\"}]\nDefault is a read-only preview. Repeated runs reuse the same campaign license; expiry is never silently extended.");
  process.exit(values.help ? 0 : 2);
}
const mode = values.mode, days = Number(values.days);
if (!["live", "test"].includes(mode) || !Number.isInteger(days) || days < 1 || days > 90 || !/^[a-z0-9-]{1,64}$/.test(values.campaign)) throw new Error("Use live/test mode, 1–90 days and a simple campaign name.");
const trust = JSON.parse(await readFile("config/releases/keygen.json", "utf8"))[mode];
const members = JSON.parse(await readFile(values.members, "utf8"));
if (!Array.isArray(members) || !members.length || members.length > 100 || members.some(m => typeof m.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email) || [m.firstName,m.lastName].some(n => n !== undefined && (typeof n !== "string" || n.length > 100)))) throw new Error("Members must contain 1–100 valid emails and optional names.");
if (new Set(members.map(m => m.email.trim().toLowerCase())).size !== members.length) throw new Error("Remove duplicate member emails.");
const client = new Keygen();
if (client.accountId !== trust.accountId) throw new Error("Operator account does not match this release.");
const product = (await client.request(`/products/${trust.productId}`)).data;
if (product.attributes.metadata?.deviceDeckMode !== mode || product.attributes.metadata?.managedBy !== "device-deck-release-tools") throw new Error("Product identity does not match Device Deck.");
const policy = (await client.request(`/policies/${trust.proPolicyId}`)).data;
if (policy.relationships.product.data.id !== trust.productId) throw new Error("Policy belongs to another product.");
const directory = path.resolve("work/release-secrets/team", mode, values.campaign);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const lockPath = path.join(directory, ".issue.lock");
const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error(`Another issuance run is active. Inspect ${lockPath}.`); });
try {
  await lock.writeFile(String(process.pid));
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    let user;
    try { user = (await client.request(`/users/${encodeURIComponent(email)}`)).data; }
    catch(error) { if (!error.message.includes("HTTP 404;")) throw error; }
    if (user && user.attributes.email.toLowerCase() !== email) throw new Error("Keygen user identity mismatch.");
    const existing = user ? (await client.list(`/licenses?product=${trust.productId}&owner=${user.id}`)).filter(l => l.attributes.metadata?.deviceDeckCampaign === values.campaign && l.attributes.metadata?.deviceDeckIssuer === "complimentary-team") : [];
    if (existing.length > 1) throw new Error("Multiple campaign licenses exist for a member; review before issuing another.");
    let license = existing[0];
    if (license && (license.relationships.policy.data.id !== trust.proPolicyId || license.attributes.metadata?.deviceDeckMode !== mode || license.attributes.suspended || !isFutureExpiry(license.attributes.expiry))) throw new Error("An existing campaign license is held, expired or mismatched. Review it explicitly; no replacement was created.");
    if (!values.apply) { console.log(JSON.stringify({ email, action: license ? "reuse" : "issue", mode, days, maxMachines: policy.attributes.maxMachines })); continue; }
    user ||= await client.create("users", { email, ...(member.firstName ? { firstName: member.firstName } : {}), ...(member.lastName ? { lastName: member.lastName } : {}) });
    license ||= await client.create("licenses", {
      name: "Device Deck team beta", expiry: new Date(Date.now() + days * 86400000).toISOString(),
      metadata: { deviceDeckMode: mode, deviceDeckIssuer: "complimentary-team", deviceDeckCampaign: values.campaign },
    }, { policy: relation("policies", trust.proPolicyId), owner: relation("users", user.id) });
    if (!license.attributes.key) throw new Error("Keygen did not return the license key.");
    const keyFile = path.join(directory, `${license.id}.key`);
    await writePrivateFile(keyFile, license.attributes.key + "\n");
    await writePrivateFile(path.join(directory, `${license.id}.json`), JSON.stringify({ email, licenseId: license.id, productId: trust.productId, mode, expiry: license.attributes.expiry, keyFile }, null, 2) + "\n");
    console.log(JSON.stringify({ email, licenseId: license.id, expiry: license.attributes.expiry, keyFile }));
  }
} finally { await lock.close(); await rm(lockPath, { force: true }); }
