import test from "node:test";
import assert from "node:assert/strict";
import { UnlockedEnterpriseLicense } from "./enterprise";
import { FEATURES } from "./trust";

test("unlocked enterprise entitlement grants every feature with no session cap and ignores deactivation", async () => {
  const license = new UnlockedEnterpriseLicense();
  await license.init();
  const status = license.status();
  assert.equal(status.tier, "free");
  assert.equal(status.state, "active");
  assert.equal(status.maxSessions, null);
  assert.match(status.message, /free and open source/);
  assert.deepEqual([...status.features].sort(), Object.values(FEATURES).sort());
  assert.equal((await license.deactivate()).maxSessions, null);
  assert.equal((await license.activate("ignored")).tier, "free");
});
