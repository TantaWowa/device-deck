import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

function command(file, args) {
  try { return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error(`${path.basename(file)} signing setup failed. Secret arguments have been withheld.`); }
}
const keychainPaths = output => [...output.matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
function locations(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || !env.RUNNER_TEMP)
    throw new Error("This signing bootstrap is for ephemeral GitHub runners only.");
  const directory = path.join(env.RUNNER_TEMP, "device-deck-signing");
  return { directory, keychain: path.join(directory, "release.keychain-db"), stateFile: path.join(directory, "previous-keychains.json") };
}

export function signingIdentities(output, teamId) {
  const identities = {};
  for (const kind of ["APPLICATION", "INSTALLER"]) {
    const name = kind === "APPLICATION" ? "Application" : "Installer";
    const matches = [...output.matchAll(/"([^"\n]+)"/g)].map(match => match[1])
      .filter(identity => identity.startsWith(`Developer ID ${name}: `) && identity.endsWith(`(${teamId})`));
    if (matches.length !== 1) throw new Error(`Expected exactly one valid Developer ID ${name} identity for the configured Apple team.`);
    identities[`DEVICE_DECK_${kind}_IDENTITY`] = matches[0];
  }
  return identities;
}

export async function cleanupCISigning({ env = process.env, run = command } = {}) {
  const { directory, keychain, stateFile } = locations(env);
  let previous;
  try { previous = JSON.parse(await readFile(stateFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const failures = [];
  // Restore the runner first, then remove all credentials created by this job.
  for (const args of [
    ["default-keychain", "-d", "user", "-s", previous.default],
    ["list-keychains", "-d", "user", "-s", ...previous.search],
    ["delete-keychain", keychain],
  ]) {
    try { run("/usr/bin/security", args); } catch { failures.push(args[0]); }
  }
  await rm(directory, { recursive: true, force: true });
  if (failures.length) throw new Error(`Signing cleanup failed: ${failures.join(", ")}. Temporary signing files were removed.`);
}

export async function setupCISigning({ env = process.env, run = command } = {}) {
  const { directory, keychain, stateFile } = locations(env);
  const apiKeyNames = ["DEVICE_DECK_NOTARY_KEY_ID", "DEVICE_DECK_NOTARY_ISSUER", "DEVICE_DECK_NOTARY_PRIVATE_KEY"];
  const apiKey = apiKeyNames.some(name => Boolean(env[name]));
  const names = ["DEVICE_DECK_APPLICATION_P12", "DEVICE_DECK_INSTALLER_P12", "DEVICE_DECK_P12_PASSWORD", "DEVICE_DECK_APPLE_TEAM_ID", "GITHUB_ENV",
    ...(apiKey ? apiKeyNames : ["DEVICE_DECK_APPLE_ID", "DEVICE_DECK_APPLE_APP_PASSWORD"])];
  for (const name of names) if (!env[name]) throw new Error(`Missing public release setting: ${name}`);
  const previous = {
    default: keychainPaths(run("/usr/bin/security", ["default-keychain", "-d", "user"]))[0],
    search: keychainPaths(run("/usr/bin/security", ["list-keychains", "-d", "user"])),
  };
  if (!previous.default || !previous.search.length) throw new Error("Cannot safely preserve the runner's original keychain settings.");
  // Fail on an existing directory instead of replacing an unknown keychain.
  await mkdir(directory, { mode: 0o700 });
  await writeFile(stateFile, JSON.stringify(previous), { mode: 0o600, flag: "wx" });
  try {
    const password = randomBytes(32).toString("hex");
    run("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
    run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    for (const kind of ["APPLICATION", "INSTALLER"]) {
      const file = path.join(directory, `${kind.toLowerCase()}.p12`);
      const certificate = Buffer.from(env[`DEVICE_DECK_${kind}_P12`], "base64");
      if (!certificate.length) throw new Error(`The ${kind.toLowerCase()} certificate is empty.`);
      try {
        await writeFile(file, certificate, { mode: 0o600, flag: "wx" });
        run("/usr/bin/security", ["import", file, "-k", keychain, "-P", env.DEVICE_DECK_P12_PASSWORD, "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild"]);
      } finally { await rm(file, { force: true }); }
    }
    run("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    const identities = signingIdentities(run("/usr/bin/security", ["find-identity", "-v", keychain]), env.DEVICE_DECK_APPLE_TEAM_ID);
    run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", keychain, ...previous.search]);
    const privateKey = path.join(directory, "AuthKey.p8");
    try {
      if (apiKey) await writeFile(privateKey, env.DEVICE_DECK_NOTARY_PRIVATE_KEY, { mode: 0o600, flag: "wx" });
      const authentication = apiKey
        ? ["--key", privateKey, "--key-id", env.DEVICE_DECK_NOTARY_KEY_ID, "--issuer", env.DEVICE_DECK_NOTARY_ISSUER]
        : ["--apple-id", env.DEVICE_DECK_APPLE_ID, "--team-id", env.DEVICE_DECK_APPLE_TEAM_ID, "--password", env.DEVICE_DECK_APPLE_APP_PASSWORD];
      run("/usr/bin/xcrun", ["notarytool", "store-credentials", "device-deck", "--keychain", keychain, ...authentication]);
    } finally { if (apiKey) await rm(privateKey, { force: true }); }
    run("/usr/bin/security", ["default-keychain", "-d", "user", "-s", keychain]);
    await appendFile(env.GITHUB_ENV, Object.entries({ ...identities, DEVICE_DECK_NOTARY_PROFILE: "device-deck" })
      .map(([key, value]) => `${key}=${value}\n`).join(""));
  } catch (error) {
    try { await cleanupCISigning({ env, run }); }
    catch { throw new Error(`${error.message} Signing cleanup also failed; temporary files were removed.`); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--cleanup")) await cleanupCISigning();
  else {
    await setupCISigning();
    console.log("Temporary Developer ID signing keychain and notarization profile are ready.");
  }
}
