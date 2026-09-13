import { mkdir, readFile, writeFile, open, rm } from "node:fs/promises";
import { isFutureExpiry, environmentCreationBody } from "./operator-files.mjs";
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { parseArgs } from "node:util";
import { Keygen } from "./keygen.mjs";
const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
const repo = "TantaWowa/device-deck";
const config = JSON.parse(await readFile("config/releases/keygen.json", "utf8"));
const permissions = ["product.read", "release.read", "release.create", "release.publish", "artifact.read", "artifact.create", "artifact.update"];
const client = new Keygen({token:process.env.KEYGEN_ADMIN_TOKEN});
console.log(JSON.stringify({ repository:repo, environments:["device-deck-team","device-deck-public"], tokenScope:"one Device Deck product per environment", permissions, apply:values.apply }));
if (!values.apply) process.exit(0);
await mkdir("work/release-secrets",{recursive:true,mode:0o700});
const lockPath = "work/release-secrets/.setup-github.lock";
const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error(`Another setup run may be active. Inspect ${lockPath} before retrying.`); });
try {
await lock.writeFile(String(process.pid));
function gh(args,input) {
  try {return execFileSync("gh",args,{input,encoding:"utf8",stdio:["pipe","pipe","pipe"]});}
  catch {throw new Error(`GitHub setup failed during ${args[0]} ${args[1]}. Credentials were not printed. Check repository/environment administration access.`);}
}
function existingEnvironment(name) {
  try { return JSON.parse(execFileSync("gh", ["api", `repos/${repo}/environments/${name}`], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })); }
  catch (error) {
    if (String(error.stderr).includes("HTTP 404")) return undefined;
    throw new Error("Unable to inspect existing GitHub environment protections; no environment settings were changed.");
  }
}
const privateSigningKey = await readFile("work/release-secrets/release-signing.pem","utf8");
const releaseTrust = JSON.parse(await readFile("config/releases/distribution.json", "utf8"));
const signingPublicKey = createPublicKey(privateSigningKey);
if (signingPublicKey.asymmetricKeyType !== "ed25519" || signingPublicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") !== releaseTrust.publicKey) throw new Error("The private release-signing key does not match the public trust compiled into Device Deck. No GitHub secrets were updated.");
for (const mode of ["test","live"]) {
  const trust=config[mode], environment=mode==="test"?"device-deck-team":"device-deck-public";
  if(client.accountId!==trust.accountId)throw new Error("Keygen account mismatch.");
  const file=`work/release-secrets/${mode}-release-token.json`, name=`Device Deck ${mode} GitHub releases`;
  let credential;
  try {credential=JSON.parse(await readFile(file,"utf8"));}
  catch(error) {
    if(error.code!=="ENOENT")throw error;
    const existing=await client.list(`/products/${trust.productId}/tokens`);
    if(existing.some(t=>t.attributes.name===name))throw new Error(`A ${mode} release token exists but the private local receipt is missing. Recover or revoke that exact token before retrying.`);
    const data=(await client.request(`/products/${trust.productId}/tokens`,{method:"POST",body:{data:{type:"tokens",attributes:{name,expiry:new Date(Date.now()+365*86400000).toISOString(),permissions}}}})).data;
    credential={id:data.id,token:data.attributes.token,productId:trust.productId,expiry:data.attributes.expiry};
    if(!credential.token)throw new Error("Keygen did not return a token.");
    await writeFile(file,JSON.stringify(credential),{mode:0o600,flag:"wx"});
  }
  if(credential.productId!==trust.productId || typeof credential.token!=="string" || !credential.token || !isFutureExpiry(credential.expiry))throw new Error("Saved release token is expired, incomplete or belongs to another product. Review it explicitly.");
  const tokenClient=new Keygen({accountId:trust.accountId,token:credential.token});
  await tokenClient.request(`/products/${trust.productId}`);
  // Environments keep beta/public credentials distinct. Publishing is manual;
  // the public workflow also requires main, stable version and notarization.
  const existing = existingEnvironment(environment);
  // A PUT with omitted protection fields can reset reviewer/wait rules. Only
  // create missing environments; reruns preserve all existing protections.
  if (!existing) gh(["api","--method","PUT",`repos/${repo}/environments/${environment}`,"--input","-"],JSON.stringify(environmentCreationBody(mode)));
  else if (mode === "live" && !existing.deployment_branch_policy?.custom_branch_policies && !existing.deployment_branch_policy?.protected_branches) throw new Error("The public environment already exists without branch restrictions. Configure those explicitly before attaching release credentials.");
  if(mode==="live") {
    if (!existing?.deployment_branch_policy?.protected_branches) {
      const policies=JSON.parse(gh(["api",`repos/${repo}/environments/${environment}/deployment-branch-policies`]));
      if (policies.branch_policies?.some(p=>p.name!=="main"||p.type!=="branch")) throw new Error("Public environment has additional branch policies. Review them explicitly before attaching release credentials.");
      if(!policies.branch_policies?.some(p=>p.name==="main"&&p.type==="branch"))gh(["api","--method","POST",`repos/${repo}/environments/${environment}/deployment-branch-policies`,"--input","-"],JSON.stringify({name:"main",type:"branch"}));
    }
  }
  gh(["secret","set","KEYGEN_TOKEN","--repo",repo,"--env",environment],credential.token);
  gh(["secret","set","DEVICE_DECK_RELEASE_SIGNING_KEY","--repo",repo,"--env",environment],privateSigningKey);
  gh(["variable","set","KEYGEN_ACCOUNT_ID","--repo",repo,"--env",environment,"--body",trust.accountId]);
  console.log(JSON.stringify({environment,productId:trust.productId,tokenId:credential.id,expiry:credential.expiry,configured:true}));
}
} finally { await lock.close(); await rm(lockPath, { force: true }); }
