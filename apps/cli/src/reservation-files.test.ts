import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readGroupCredential,
  readReservationManifest,
  releaseGroupCredential,
  reservationCommandOutput,
  prepareGroupCredential,
} from "./reservation-files";

test("reservation manifest and result files are validated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-reservation-"));
  try {
    const manifestFile = path.join(directory, "manifest.json");
    await writeFile(
      manifestFile,
      JSON.stringify({
        version: 1,
        groupId: "repo/run/attempt",
        owner: "CI",
        reason: "Regression",
        requests: {
          phone: {
            selector: {
              platform: "Android",
              kind: "virtual",
              formFactor: "phone",
              tags: ["ci"],
            },
          },
        },
      }),
    );
    assert.equal(
      (await readReservationManifest(manifestFile)).requests.phone.selector
        .formFactor,
      "phone",
    );
    const resultFile = path.join(directory, "result.json");
    await writeFile(
      resultFile,
      JSON.stringify({ groupId: "repo/run/attempt", leaseToken: "secret", devices: {} }),
    );
    assert.deepEqual(await readGroupCredential(resultFile), {
      groupId: "repo/run/attempt",
      leaseToken: "secret",
    });
    await writeFile(resultFile, JSON.stringify({ groupId: "missing-token" }));
    await assert.rejects(readGroupCredential(resultFile), /groupId and leaseToken/);
    assert.deepEqual(
      await releaseGroupCredential(
        { groupId: "never-committed", leaseToken: "x".repeat(32) },
        async () => {
          throw new (await import("../../../packages/core/src/local/types")).DeckError(
            "group-not-found",
            "missing",
            404,
          );
        },
      ),
      { groupId: "never-committed", state: "not-found" },
    );
    const safe = reservationCommandOutput(
      { groupId: "run", leaseToken: "do-not-log", devices: {} },
      resultFile,
    );
    assert.equal(JSON.stringify(safe).includes("do-not-log"), false);
    assert.equal((safe as any).credentialFile, resultFile);
    const retryFile = path.join(directory, "retry.json");
    let generated = 0;
    const first = await prepareGroupCredential(retryFile, "same-run", () => {
      generated++;
      return "persisted-secret";
    });
    const retry = await prepareGroupCredential(retryFile, "same-run", () => {
      generated++;
      return "replacement-secret";
    });
    assert.deepEqual(retry, first);
    assert.equal(generated, 1);
    await assert.rejects(
      prepareGroupCredential(retryFile, "different-run", () => "unused"),
      /Refusing to overwrite/,
    );
    const concurrentFile = path.join(directory, "concurrent.json");
    let sequence = 0;
    const concurrent = await Promise.all([
      prepareGroupCredential(concurrentFile, "concurrent-run", () => `token-${++sequence}`),
      prepareGroupCredential(concurrentFile, "concurrent-run", () => `token-${++sequence}`),
    ]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.deepEqual(await readGroupCredential(concurrentFile), concurrent[0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
