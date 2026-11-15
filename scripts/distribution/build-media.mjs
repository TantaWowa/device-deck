import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { digest, minimumOS, validateMediaBundle } from "./package-support.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export function validateSources(lock) {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.components)) throw new Error("Invalid media source lock.");
  const expected = ["freetype", "fribidi", "harfbuzz", "libass", "x264", "ffmpeg"];
  if (JSON.stringify(lock.components.map((entry) => entry.name)) !== JSON.stringify(expected)) throw new Error("Media sources must name each build dependency in build order.");
  for (const source of lock.components) {
    if (!source.version || !source.license || !/^[a-f0-9]{64}$/.test(source.sha256) ||
        new URL(source.url).protocol !== "https:" || !source.notices?.length ||
        source.notices.some((file) => path.isAbsolute(file) || file.split(/[\\/]/).includes("..")))
      throw new Error(`Invalid pinned media source: ${source.name}`);
  }
  return lock;
}

export function buildSteps(name, { prefix, source, arch, jobs, sdk }) {
  const configure = (options) => [["./configure", [`--prefix=${prefix}`, ...options]]];
  const make = [["/usr/bin/make", [`-j${jobs}`]], ["/usr/bin/make", ["install"]]];
  const staticLibrary = ["--disable-shared", "--enable-static"];
  switch (name) {
    case "freetype": return [...configure([...staticLibrary, "--without-zlib", "--without-bzip2", "--without-png", "--without-harfbuzz", "--without-brotli"]), ...make];
    // Only the library is shipped. Building FriBidi's CLI manuals would require help2man.
    case "fribidi": return [...configure(staticLibrary), ["/usr/bin/make", ["-C", "lib", `-j${jobs}`]], ["/usr/bin/make", ["-C", "lib", "install"]], ["/usr/bin/make", ["install-pkgconfigDATA"]]];
    case "harfbuzz": return [
      ["cmake", ["-S", source, "-B", "cmake-build", `-DCMAKE_INSTALL_PREFIX=${prefix}`, "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_OSX_DEPLOYMENT_TARGET=${minimumOS}`, `-DCMAKE_OSX_SYSROOT=${sdk}`, `-DCMAKE_OSX_ARCHITECTURES=${arch === "x64" ? "x86_64" : arch}`, "-DBUILD_SHARED_LIBS=OFF", "-DHB_BUILD_UTILS=OFF", "-DHB_BUILD_SUBSET=OFF", "-DHB_BUILD_RASTER=OFF", "-DHB_BUILD_VECTOR=OFF", "-DHB_BUILD_GPU=OFF", "-DHB_BUILD_GPU_DEMO=OFF", "-DHB_HAVE_CAIRO=OFF", "-DHB_HAVE_FREETYPE=OFF", "-DHB_HAVE_GLIB=OFF", "-DHB_HAVE_ICU=OFF", "-DHB_HAVE_GRAPHITE2=OFF", "-DHB_HAVE_CORETEXT=OFF"]],
      ["cmake", ["--build", "cmake-build", "--parallel", String(jobs)]], ["cmake", ["--install", "cmake-build"]],
    ];
    case "libass": return [...configure([...staticLibrary, "--disable-fontconfig", "--disable-libunibreak", "--enable-coretext"]), ...make];
    case "x264": return [...configure(["--enable-static", "--enable-pic", "--disable-cli", "--disable-opencl", "--disable-avs", "--disable-lavf", "--disable-swscale", "--disable-ffms"]), ...make];
    case "ffmpeg": return [...configure(["--disable-shared", "--enable-static", "--disable-autodetect", "--enable-gpl", "--enable-libx264", "--enable-libass", "--enable-zlib", "--enable-videotoolbox", "--enable-audiotoolbox", "--enable-avfoundation", "--disable-ffplay", "--disable-doc", "--disable-debug", "--pkg-config-flags=--static", `--extra-cflags=-I${prefix}/include -mmacosx-version-min=${minimumOS}`, `--extra-ldflags=-L${prefix}/lib -mmacosx-version-min=${minimumOS}`, "--extra-libs=-lc++"]), ...make];
    default: throw new Error(`Unknown media dependency: ${name}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: "string" }, work: { type: "string", default: path.join(os.homedir(), "hope-scratch/device-deck-media") }, jobs: { type: "string", default: String(Math.min(os.availableParallelism(), 8)) }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Build the bundled Mac capture encoder from pinned upstream sources.\nUsage: node scripts/distribution/build-media.mjs --output DIR [--work DIR] [--jobs N]\nBuild prerequisites: Xcode command-line tools, CMake, pkg-config; Intel also needs NASM.\nNo Homebrew libraries are used. Sources, notices and this recipe are included in the bundle.");
    return;
  }
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("Build on the target Apple silicon or Intel Mac.");
  if (!values.output) throw new Error("Pass --output with the destination media bundle directory.");
  const jobs = Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error("--jobs must be an integer between 1 and 64.");
  const work = path.resolve(values.work), output = path.resolve(values.output), arch = process.arch;
  const lockBytes = await readFile(path.join(here, "media-sources.json"));
  const lock = validateSources(JSON.parse(lockBytes));
  const recipe = await readFile(fileURLToPath(import.meta.url));
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  const compiler = execFileSync("/usr/bin/clang", ["--version"], { encoding: "utf8" }).trim();
  for (const tool of ["cmake", "pkg-config", ...(arch === "x64" ? ["nasm"] : [])]) execFileSync(tool, ["--version"], { stdio: "pipe" });
  const key = digest(Buffer.concat([lockBytes, recipe, Buffer.from(`${arch}\n${sdk}\n${compiler}`)])).slice(0, 20);
  const build = path.join(work, `${arch}-${key}`), prefix = path.join(build, "prefix"), cache = path.join(work, "cache");
  if ([work, build, cache].some((directory) => directory === output || directory.startsWith(`${output}${path.sep}`))) throw new Error("The output cannot contain the source cache or build directory.");
  const existingOutput = await lstat(output).catch(() => undefined);
  if (existingOutput && (!existingOutput.isDirectory() || !(await readFile(path.join(output, "media-manifest.json")).catch(() => undefined)))) throw new Error("Refusing to replace an existing path that is not a media bundle.");
  await mkdir(cache, { recursive: true });
  await mkdir(prefix, { recursive: true });
  const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: minimumOS, SDKROOT: sdk, CC: "/usr/bin/clang", CXX: "/usr/bin/clang++", CFLAGS: `-O2 -mmacosx-version-min=${minimumOS}`, CXXFLAGS: `-O2 -mmacosx-version-min=${minimumOS}`, CPPFLAGS: `-I${prefix}/include`, LDFLAGS: `-L${prefix}/lib -mmacosx-version-min=${minimumOS}`, PKG_CONFIG_PATH: "", PKG_CONFIG_LIBDIR: `${prefix}/lib/pkgconfig:${prefix}/share/pkgconfig`, CMAKE_PREFIX_PATH: prefix, SOURCE_DATE_EPOCH: "1767225600", ZERO_AR_DATE: "1" };
  // Do not let a developer's custom include/library paths leak Homebrew libraries into the bundle.
  for (const variable of ["CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"]) delete env[variable];
  const commands = [];
  const run = async (file, args, cwd, log) => {
    commands.push({ file, args, cwd: path.relative(build, cwd) });
    try { const result = execFileSync(file, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); await writeFile(log, result); }
    catch (error) { const text = `${error.stdout ?? ""}\n${error.stderr ?? ""}`; await writeFile(log, text); throw new Error(`${file} failed. Log: ${log}\n${text.split("\n").slice(-35).join("\n")}`); }
  };
  for (const component of lock.components) {
    const archive = path.join(cache, path.basename(new URL(component.url).pathname));
    let downloaded = await readFile(archive).catch(() => undefined);
    if (!downloaded || digest(downloaded) !== component.sha256) {
      const temporary = `${archive}.download`;
      execFileSync("/usr/bin/curl", ["--fail", "--location", "--proto", "=https", "--tlsv1.2", "--retry", "3", "--output", temporary, component.url], { stdio: "inherit" });
      downloaded = await readFile(temporary);
      if (digest(downloaded) !== component.sha256) { await rm(temporary, { force: true }); throw new Error(`Source checksum mismatch: ${component.name}`); }
      await rename(temporary, archive);
    }
    const source = path.join(build, component.name), stamp = path.join(build, `${component.name}.complete`);
    if (await readFile(stamp, "utf8").catch(() => "") === key) { console.log(`Using completed ${component.name} ${component.version}`); continue; }
    console.log(`Building ${component.name} ${component.version} for ${arch}`);
    await rm(source, { recursive: true, force: true });
    await mkdir(source, { recursive: true });
    execFileSync("/usr/bin/tar", ["-xf", archive, "--strip-components=1", "-C", source]);
    const steps = buildSteps(component.name, { prefix, source, arch, jobs, sdk });
    for (let i = 0; i < steps.length; i++) await run(...steps[i], source, path.join(build, `${component.name}-${i}.log`));
    await writeFile(stamp, key);
  }
  const staging = `${output}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  for (const folder of ["bin", "sources", "licenses", "recipe"]) await mkdir(path.join(staging, folder), { recursive: true });
  for (const binary of ["ffmpeg", "ffprobe"]) { await copyFile(path.join(prefix, "bin", binary), path.join(staging, "bin", binary)); await chmod(path.join(staging, "bin", binary), 0o755); }
  const components = [];
  for (const component of lock.components) {
    const filename = path.basename(new URL(component.url).pathname), source = `sources/${filename}`, notices = `licenses/${component.name}.txt`;
    await copyFile(path.join(cache, filename), path.join(staging, source));
    const texts = await Promise.all(component.notices.map(async (file) => `\n--- ${file} ---\n${await readFile(path.join(build, component.name, file), "utf8")}`));
    await writeFile(path.join(staging, notices), `${component.name} ${component.version}\n${component.url}\nLicense selected for this build: ${component.license}\n${texts.join("\n")}`);
    const files = [source, notices, ...(component.name === "ffmpeg" ? ["bin/ffmpeg", "bin/ffprobe"] : [])];
    components.push({ name: component.name, version: component.version, license: component.license, source, notices, ...(component.name !== "ffmpeg" ? { staticallyLinkedInto: ["bin/ffmpeg", "bin/ffprobe"] } : {}), files: await Promise.all(files.map(async (file) => ({ path: file, sha256: digest(await readFile(path.join(staging, file))) }))) });
  }
  await copyFile(fileURLToPath(import.meta.url), path.join(staging, "recipe/build-media.mjs"));
  await copyFile(path.join(here, "package-support.mjs"), path.join(staging, "recipe/package-support.mjs"));
  await copyFile(path.join(here, "media-sources.json"), path.join(staging, "recipe/media-sources.json"));
  await writeFile(path.join(staging, "recipe/build.json"), JSON.stringify({ arch, minimumOS, compiler, sdk, sourceLockSha256: digest(lockBytes), recipeSha256: digest(recipe), commands }, null, 2) + "\n");
  await writeFile(path.join(staging, "README.txt"), "Device Deck capture tools\n\nFFmpeg and ffprobe run as separate executable programs. The encoder build is GPL-2.0-or-later. Each dependency's selected license and notices are in licenses/. Complete matching upstream sources are in sources/.\n\nTo rebuild on the matching Mac architecture, install Xcode command-line tools, CMake and pkg-config (Intel also needs NASM), then run:\nnode recipe/build-media.mjs --output /absolute/path/to/new-bundle\n\nFor an offline rebuild, copy sources/* into WORK/cache and add --work WORK. No source patches are applied. Build details are in recipe/build.json. macOS system frameworks and libraries are supplied by the operating system.\n");
  await writeFile(path.join(staging, "media-manifest.json"), JSON.stringify({ schemaVersion: 1, arch, components }, null, 2) + "\n");
  await validateMediaBundle(staging, arch);
  await proveMedia(staging, build);
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  console.log(`Validated bundled capture tools: ${output}`);
}

export async function proveMedia(bundle, work) {
  const proof = path.join(work, "capture-proof");
  await mkdir(proof, { recursive: true });
  const ass = path.join(proof, "overlay.ass"), movie = path.join(proof, "capture.mp4"), png = path.join(proof, "capture.png");
  await writeFile(ass, "[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 240\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Helvetica,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Device Deck\n");
  const env = { PATH: "/usr/bin:/bin", HOME: os.homedir() };
  const ffmpeg = path.join(bundle, "bin/ffmpeg"), ffprobe = path.join(bundle, "bin/ffprobe");
  // Use a relative filter path so spaces in the build directory need no FFmpeg filter escaping.
  const run = (file, args) => execFileSync(file, args, { cwd: proof, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=15", "-t", "0.5", "-vf", "ass=overlay.ass", "-c:v", "libx264", "-pix_fmt", "yuv420p", movie]);
  run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", movie, "-frames:v", "1", png]);
  const metadata = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", movie]));
  if (!metadata.streams.some((stream) => stream.codec_name === "h264" && stream.width === 320 && stream.height === 240) || !(await readFile(png)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Bundled capture proof failed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
