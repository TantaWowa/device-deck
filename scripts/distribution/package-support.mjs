import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const bundleId = "com.tantawowa.device-deck";
export const minimumOS = "14.0";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function numericVersion(version) {
  const match = /^(\d+\.\d+\.\d+)(?:-(?:alpha|beta|rc)\.\d+)?$/.exec(version);
  if (!match) throw new Error("Use major.minor.patch or major.minor.patch-beta.N (alpha/rc also supported).");
  return match[1];
}

export function requireReleaseSettings({ release, mode, applicationIdentity, installerIdentity, notaryProfile }) {
  if (!release) return;
  if (mode !== "live") throw new Error("Public releases require live licensing trust.");
  if (!applicationIdentity?.startsWith("Developer ID Application:")) throw new Error("Public releases require DEVICE_DECK_APPLICATION_IDENTITY (Developer ID Application).");
  if (!installerIdentity?.startsWith("Developer ID Installer:")) throw new Error("Public releases require DEVICE_DECK_INSTALLER_IDENTITY (Developer ID Installer).");
  if (!notaryProfile) throw new Error("Public releases require DEVICE_DECK_NOTARY_PROFILE, saved with xcrun notarytool store-credentials.");
}

export function appInfo(version) {
  const numeric = numericVersion(version);
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Device Deck</string>
<key>CFBundleDisplayName</key><string>Device Deck</string>
<key>CFBundleExecutable</key><string>Device Deck</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${numeric}</string>
<key>CFBundleVersion</key><string>${numeric}</string>
<key>DeviceDeckReleaseVersion</key><string>${xml(version)}</string>
<key>LSMinimumSystemVersion</key><string>${minimumOS}</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSCameraUsageDescription</key><string>Device Deck previews and records the capture cards you select.</string>
<key>NSCameraUseContinuityCameraDeviceType</key><true/>
</dict></plist>\n`;
}

export const preinstall = `#!/bin/sh
set -eu
DEVICE_DECK_VOLUME=\${3:-/}
DEVICE_DECK_INSTALLED="\${DEVICE_DECK_VOLUME%/}/Applications/Device Deck.app"
if [ -L "$DEVICE_DECK_INSTALLED" ]; then
  echo "Refusing to replace an application symlink. Move it explicitly before installing." >&2
  exit 1
fi
if [ -e "$DEVICE_DECK_INSTALLED" ]; then
  DEVICE_DECK_IDENTIFIER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$DEVICE_DECK_INSTALLED/Contents/Info.plist")
  if [ "$DEVICE_DECK_IDENTIFIER" != 'com.tantawowa.device-deck' ]; then
    echo "Another application occupies $DEVICE_DECK_INSTALLED. Move it explicitly before installing." >&2
    exit 1
  fi
  # Refuse even idle running instances. Never terminate a capture for an upgrade.
  DEVICE_DECK_PROCESSES=$(/bin/ps -axo command=)
  if echo "$DEVICE_DECK_PROCESSES" | /usr/bin/awk -v app="$DEVICE_DECK_INSTALLED/Contents/" 'index($0, app "MacOS/Device Deck") == 1 || index($0, app "Resources/runtime/bin/node") == 1 { found=1 } END { exit !found }'; then
    echo "Device Deck is running. Finish reservations and recordings, quit Device Deck, then run devdeck stop before installing this update." >&2
    exit 1
  fi
fi
exit 0
`;

export const postinstall = `#!/bin/sh
set -eu
DEVICE_DECK_VOLUME=\${3:-/}
DEVICE_DECK_BIN="\${DEVICE_DECK_VOLUME%/}/usr/local/bin"
DEVICE_DECK_CLI="$DEVICE_DECK_BIN/devdeck"
DEVICE_DECK_TARGET="/Applications/Device Deck.app/Contents/MacOS/devdeck"
/bin/mkdir -p "$DEVICE_DECK_BIN"
if [ -L "$DEVICE_DECK_CLI" ] && [ "$(/usr/bin/readlink "$DEVICE_DECK_CLI")" = "$DEVICE_DECK_TARGET" ]; then
  exit 0
fi
if [ -e "$DEVICE_DECK_CLI" ] || [ -L "$DEVICE_DECK_CLI" ]; then
  echo "Device Deck installed. Existing $DEVICE_DECK_CLI was preserved. Use $DEVICE_DECK_TARGET directly, or explicitly move your previous devdeck launcher before creating the application link." >&2
else
  /bin/ln -s "$DEVICE_DECK_TARGET" "$DEVICE_DECK_CLI"
fi
exit 0
`;

export function captureSetup(media) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Device Deck capture setup</title><style>body{font:17px/1.6 system-ui;max-width:750px;margin:50px auto;padding:0 25px;color:#173048}h1{line-height:1.2}code,pre{background:#edf3f8;border-radius:6px;padding:3px 7px}pre{padding:16px;overflow:auto}a{color:#06709a}</style><h1>Device Deck capture setup</h1>
<p>Device Deck includes its own Node runtime and Mac camera helper. Open the app, allow Camera access when asked, then use <strong>Devices → Discover → Add selected</strong>.</p>
${media === "external" ? `<h2>Enable recording and image conversion</h2><p>This team package uses a separate FFmpeg installation for recording, screenshots from USB feeds, and annotations. Live previews work without it. If <code>ffmpeg</code> and <code>ffprobe</code> are missing, install <a href="https://brew.sh">Homebrew</a>, then run:</p><pre>brew install ffmpeg</pre><p>Quit and reopen Device Deck afterwards. Check readiness in the web app’s Settings diagnostics. Homebrew’s standard Apple Silicon and Intel install locations are detected automatically. For a custom installation, set the absolute <code>ffmpeg</code> and <code>ffprobe</code> paths in Settings.</p>` : `<p>This package includes the capture encoder and its dependencies. Their notices and matching source material are in <code>Contents/Resources/media</code> inside the application.</p>`}
<h2>Only add the platform tools you need</h2><p>Roku control and USB preview require no additional SDK. Android and Fire TV control need <code>adb</code>: install <code>brew install --cask android-platform-tools</code>, enable developer debugging on the device, and accept its authorization prompt. Apple simulators require Xcode and the appropriate downloaded runtimes. Physical Apple TV control requires a Python environment with <a href="https://pyatv.dev/documentation/">pyatv</a>; set that environment’s Python executable in Settings and pair the TV.</p>
<h2>Keep your work</h2><p>Configuration, licenses and history stay in <code>~/Library/Application Support/Device Deck</code>. Captures default to <code>~/Movies/Device Deck</code>. App installation and removal preserve both. Finish reservations and recordings before upgrading.</p>
<h2>Command line</h2><pre>devdeck start\ndevdeck ui\ndevdeck tui\ndevdeck service install</pre><p>The installer adds <code>/usr/local/bin/devdeck</code> when that name is available. An existing development launcher is preserved; use <code>/Applications/Device Deck.app/Contents/MacOS/devdeck</code> directly until you explicitly replace your old launcher.</p></html>`;
}

export async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Unexpected symlink in distribution payload: ${file}`);
    if (item.isDirectory()) files.push(...await walk(file));
    else if (item.isFile()) files.push(file);
    else throw new Error(`Unexpected file type in distribution payload: ${file}`);
  }
  return files;
}

export function linkedLibraries(file) {
  return execFileSync("/usr/bin/otool", ["-L", file], { encoding: "utf8" }).split("\n").slice(1)
    .map((line) => line.trim().replace(/ \(compatibility version.*$/, "")).filter(Boolean);
}

// No Homebrew Cellar paths or undeclared rpaths may survive in the package.
// The media provider must make its binaries relocatable before handing them over.
export async function verifyMachOClosure(files, arch) {
  const found = [];
  for (const file of files) {
    const type = execFileSync("/usr/bin/file", ["-b", file], { encoding: "utf8" });
    if (!type.includes("Mach-O")) continue;
    const architectures = execFileSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);
    if (!architectures.includes(arch === "x64" ? "x86_64" : arch)) throw new Error(`Wrong architecture: ${file}`);
    for (const library of linkedLibraries(file)) {
      if (library.startsWith("/System/Library/") || library.startsWith("/usr/lib/")) continue;
      if (library.startsWith("@loader_path/")) {
        const target = path.resolve(path.dirname(file), library.slice("@loader_path/".length));
        if (!files.includes(target)) throw new Error(`Missing bundled library ${library} for ${file}`);
      } else if (library.startsWith("@executable_path/")) {
        const target = path.resolve(path.dirname(file), library.slice("@executable_path/".length));
        if (!files.includes(target)) throw new Error(`Missing executable-relative library ${library} for ${file}`);
      } else throw new Error(`Non-relocatable dependency ${library} in ${file}; bundle it using @loader_path.`);
    }
    found.push(file);
  }
  return found;
}

export async function validateMediaBundle(directory, arch) {
  const manifest = JSON.parse(await readFile(path.join(directory, "media-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.arch !== arch || !Array.isArray(manifest.components) || !manifest.components.length)
    throw new Error("Media manifest requires schemaVersion 1, matching arch, and components.");
  const listed = new Set();
  for (const component of manifest.components) {
    if (!component.name || !component.version || !component.license || !component.source || !component.notices || !component.files?.length)
      throw new Error("Each media component needs name, version, license, source archive, notices, and hashed files.");
    for (const relative of [component.source, component.notices, ...component.files.map((file) => file.path)]) {
      if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Unsafe media manifest path.");
      const file = path.resolve(directory, relative);
      if (!(await lstat(file)).isFile() || (await realpath(file)) !== file) throw new Error(`Media file must be a regular file: ${relative}`);
    }
    for (const file of component.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || digest(await readFile(path.join(directory, file.path))) !== file.sha256)
        throw new Error(`Media checksum mismatch: ${file.path}`);
      listed.add(file.path);
    }
  }
  const files = await walk(directory);
  for (const name of ["bin/ffmpeg", "bin/ffprobe"]) if (!listed.has(name)) throw new Error(`Media bundle is missing ${name}`);
  const binaries = await verifyMachOClosure(files, arch);
  for (const binary of binaries) if (!listed.has(path.relative(directory, binary))) throw new Error(`Unlisted binary: ${binary}`);
  for (const name of ["ffmpeg", "ffprobe"]) execFileSync(path.join(directory, "bin", name), ["-version"], { stdio: "pipe", env: { PATH: "/usr/bin:/bin" } });
  const ffmpeg = path.join(directory, "bin/ffmpeg");
  const encoders = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const filters = execFileSync(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!/\blibx264\b/.test(encoders) || !/\bpng\b/.test(encoders) || !/\bass\b/.test(filters))
    throw new Error("The media bundle must support libx264, PNG encoding, and ASS annotations.");
  return { manifest, files, binaries };
}
