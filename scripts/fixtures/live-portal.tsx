// Test-only portal shell. The QA proxy provides a synthetic identity/grant and
// forwards media signaling to the isolated qa-live-server daemon, never a cloud account.
import React from "react";
import { createRoot } from "react-dom/client";
import { MachineWorkspace } from "../../apps/portal/src/MachineWorkspace";
import "../../apps/portal/src/style.css";
import "../../apps/portal/src/remote.css";

const machine = {
  id: "f5e2543a-10d6-4f22-863a-357209b292d8",
  name: "Synthetic Mac",
  publicKey: { kty: "OKP" as const, crv: "Ed25519" as const, x: "a".repeat(43) },
  endpoint: location.origin,
  pairingId: "56ac1be3-370b-442a-bb02-e24472f65b98",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
createRoot(document.getElementById("root")!).render(
  <MachineWorkspace
    machine={machine}
    cloud={async <T,>() => ({
      token: "fixture-grant",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }) as T}
    owner="Live video QA"
    leases={new Map()}
    onBack={() => {}}
  />,
);
