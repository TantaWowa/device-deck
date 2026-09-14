import { randomBytes } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const directory = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2),
  options = new Map();
for (let i = 0; i < argv.length; i += 2) {
  if (
    !["--mode", "--domain", "--store", "--product", "--variant"].includes(
      argv[i],
    ) ||
    !argv[i + 1]
  )
    throw new Error(
      "Usage: node apps/billing/deploy/init.mjs --mode test|live --domain billing.example.com --store ID --product ID --variant ID",
    );
  options.set(argv[i], argv[i + 1]);
}
const mode = options.get("--mode"),
  domain = options.get("--domain");
if (
  !["test", "live"].includes(mode) ||
  !domain ||
  !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)
)
  throw new Error("Choose test or live mode and a public DNS hostname");
const config = JSON.parse(
  await readFile(path.join(directory, `billing.${mode}.example.json`), "utf8"),
);
for (const name of ["store", "product", "variant"]) {
  const value = Number(options.get(`--${name}`));
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Pass the actual Lemon Squeezy --${name} ID`);
  config[`${name}Id`] = value;
}
for (const file of [".env", "billing.json"]) {
  try {
    await access(path.join(directory, file));
  } catch {
    continue;
  }
  throw new Error(
    `${file} already exists; refusing to overwrite deployment settings or secrets`,
  );
}
await writeFile(
  path.join(directory, "billing.json"),
  JSON.stringify(config, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
const env =
  [
    `COMPOSE_PROJECT_NAME=device-deck-billing-${mode}`,
    `BILLING_DOMAIN=${domain}`,
    `DEVICE_DECK_BILLING_PUBLIC_URL=https://${domain}`,
    "DEVICE_DECK_LEMON_TOKEN=REPLACE_WITH_SERVER_LEMON_TOKEN",
    "DEVICE_DECK_ISSUER_TOKEN=REPLACE_WITH_SCOPED_KEYGEN_ISSUER_TOKEN",
    ...["WEBHOOK_SECRET", "ISSUANCE_SECRET", "BILLING_ADMIN_SECRET"].map(
      (name) => `DEVICE_DECK_${name}=${randomBytes(32).toString("hex")}`,
    ),
  ].join("\n") + "\n";
await writeFile(path.join(directory, ".env"), env, { mode: 0o600, flag: "wx" });
console.log(
  "Created private deploy/.env and deploy/billing.json. Set the two provider tokens in .env, then build and launch using README.md. No provider resources were changed.",
);
