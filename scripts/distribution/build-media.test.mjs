import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSteps, validateSources } from "./build-media.mjs";

test("every bundled encoder source is pinned and has complete license notices", async () => {
  const lock = JSON.parse(await readFile(new URL("./media-sources.json", import.meta.url)));
  assert.equal(validateSources(lock), lock);
  for (const change of [
    (copy) => { copy.components[0].sha256 = ""; },
    (copy) => { copy.components[0].url = "http://unverified.invalid/source.tar.xz"; },
    (copy) => { copy.components[0].notices = ["../COPYING"]; },
    (copy) => { copy.components.pop(); },
  ]) {
    const copy = structuredClone(lock);
    change(copy);
    assert.throws(() => validateSources(copy));
  }
});

test("capture build includes required codecs and annotations without detecting host libraries", () => {
  const config = { prefix: "/temporary/prefix", source: "/temporary/source", arch: "arm64", jobs: 4, sdk: "/SDK" };
  const flags = buildSteps("ffmpeg", config)[0][1];
  for (const flag of ["--disable-autodetect", "--disable-shared", "--enable-static", "--enable-gpl", "--enable-libx264", "--enable-libass", "--enable-zlib", "--enable-videotoolbox", "--pkg-config-flags=--static"]) assert.ok(flags.includes(flag), flag);
  assert.ok(!flags.includes("--enable-nonfree"));
  for (const arch of ["arm64", "x64"]) {
    const cmake = buildSteps("harfbuzz", { ...config, arch })[0][1];
    assert.ok(cmake.includes(`-DCMAKE_OSX_ARCHITECTURES=${arch === "x64" ? "x86_64" : arch}`));
    assert.ok(cmake.includes("-DBUILD_SHARED_LIBS=OFF"));
    assert.ok(cmake.includes("-DHB_HAVE_GLIB=OFF"));
    assert.ok(cmake.includes("-DHB_HAVE_ICU=OFF"));
  }
});
