import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
test("native cache repair preserves live counters and only replaces a known idle cache", { skip: process.platform !== "darwin" }, async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "deck-sim-prefs-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../../native/macos/simulator-preferences.c", import.meta.url));
  const fixture = path.join(scratch, "fixture.c");
  await writeFile(fixture, `
#define main production_main
#include ${JSON.stringify(source)}
#undef main
#include <assert.h>

static int idle(void) { return 0; }
static int busy(void) { return 1; }
static int scans;
static int starting(void) { return scans++; }
static char name[32];
static void cleanup(void) { shm_unlink(name); }

int main(void) {
    snprintf(name, sizeof(name), "deck.test.%d", getpid());
    atexit(cleanup);
    gid_t group = getegid();
    assert(prepare_counters(name, group, false, idle) != 0);
    assert(prepare_counters(name, group, true, starting) != 0);
    assert(shm_open(name, O_RDONLY, 0) < 0 && errno == ENOENT);
    int old = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0600);
    assert(old >= 0 && ftruncate(old, counter_size) == 0);
    int *counter = mmap(NULL, counter_size, PROT_READ | PROT_WRITE, MAP_SHARED, old, 0);
    assert(counter != MAP_FAILED);
    *counter = 42;
    assert(prepare_counters(name, group, true, busy) != 0);
    scans = 0;
    assert(prepare_counters(name, group, true, starting) != 0);
    int live = shm_open(name, O_RDONLY, 0);
    const int *observed = mmap(NULL, counter_size, PROT_READ, MAP_SHARED, live, 0);
    assert(observed != MAP_FAILED && *observed == 42);
    munmap((void *)observed, counter_size); close(live);
    munmap(counter, counter_size); close(old);
    assert(prepare_counters(name, group, true, idle) == 0);
    assert(prepare_counters(name, group, false, busy) == 0);
    assert(prepare_counters(name, group, true, busy) == 0);
    assert(shm_unlink(name) == 0);
    assert(prepare_counters(name, group, true, idle) == 0);
    return 0;
}`);
  const binary = path.join(scratch, "fixture");
  await exec("/usr/bin/clang", ["-Wall", "-Werror", fixture, "-o", binary]);
  const result = await exec(binary);
  assert.match(result.stderr, /running Apple simulators/);
});
