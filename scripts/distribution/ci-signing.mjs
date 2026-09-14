import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
if(process.env.GITHUB_ACTIONS!=="true"||!process.env.RUNNER_TEMP)throw new Error("This signing bootstrap is for ephemeral GitHub runners only.");
const directory=path.join(process.env.RUNNER_TEMP,"device-deck-signing"), keychain=path.join(directory,"release.keychain-db");
function run(file,args){try{return execFileSync(file,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]});}catch{throw new Error(`${path.basename(file)} signing setup failed. Secret arguments have been withheld.`);}}
if(process.argv.includes("--cleanup")) {
  try{run("/usr/bin/security",["delete-keychain",keychain]);}catch{}
  await rm(directory,{recursive:true,force:true});
} else {
  const names=["DEVICE_DECK_APPLICATION_P12","DEVICE_DECK_INSTALLER_P12","DEVICE_DECK_P12_PASSWORD","DEVICE_DECK_APPLE_ID","DEVICE_DECK_APPLE_TEAM_ID","DEVICE_DECK_APPLE_APP_PASSWORD"];
  for(const name of names)if(!process.env[name])throw new Error(`Missing public release secret: ${name}`);
  await mkdir(directory,{recursive:true,mode:0o700});
  const password=randomBytes(32).toString("hex");
  run("/usr/bin/security",["create-keychain","-p",password,keychain]);
  run("/usr/bin/security",["set-keychain-settings","-lut","21600",keychain]);
  run("/usr/bin/security",["unlock-keychain","-p",password,keychain]);
  for(const kind of ["APPLICATION","INSTALLER"]) {
    const file=path.join(directory,`${kind.toLowerCase()}.p12`);
    await writeFile(file,Buffer.from(process.env[`DEVICE_DECK_${kind}_P12`],"base64"),{mode:0o600});
    run("/usr/bin/security",["import",file,"-k",keychain,"-P",process.env.DEVICE_DECK_P12_PASSWORD,"-T","/usr/bin/codesign","-T","/usr/bin/productbuild"]);
    await rm(file);
  }
  run("/usr/bin/security",["set-key-partition-list","-S","apple-tool:,apple:,codesign:","-s","-k",password,keychain]);
  const existing=run("/usr/bin/security",["list-keychains","-d","user"]).match(/"([^"\n]+)"/g)?.map(s=>s.slice(1,-1))||[];
  run("/usr/bin/security",["list-keychains","-d","user","-s",keychain,...existing]);
  run("/usr/bin/xcrun",["notarytool","store-credentials","device-deck","--keychain",keychain,"--apple-id",process.env.DEVICE_DECK_APPLE_ID,"--team-id",process.env.DEVICE_DECK_APPLE_TEAM_ID,"--password",process.env.DEVICE_DECK_APPLE_APP_PASSWORD]);
  // notarytool resolves profiles through the user default keychain.
  run("/usr/bin/security",["default-keychain","-d","user","-s",keychain]);
  console.log("Temporary Developer ID signing keychain and notarization profile are ready.");
}
