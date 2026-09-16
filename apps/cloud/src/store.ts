import type { HubPublicKey, MachineRecord } from "../../../packages/core/src/hub";
export type { MachineRecord } from "../../../packages/core/src/hub";

export interface PendingPairing {
  id: string;
  machineId: string;
  publicKey: HubPublicKey;
  expiresAt: string;
}

export interface MachineStore {
  listMachines(uid: string): Promise<MachineRecord[]>;
  getMachine(uid: string, machineId: string): Promise<MachineRecord | undefined>;
  createPairing(uid: string, pairing: PendingPairing): Promise<void>;
  getPairing(uid: string, pairingId: string): Promise<PendingPairing | undefined>;
  /** Atomically consumes the pending pairing and writes the owner's machine. */
  completePairing(
    uid: string,
    pairing: PendingPairing,
    details: { name: string; endpoint: string },
    now: string,
  ): Promise<MachineRecord>;
  updateMachine(
    uid: string,
    machineId: string,
    patch: { name?: string; endpoint?: string },
    now: string,
  ): Promise<MachineRecord>;
  deleteMachine(uid: string, machineId: string): Promise<boolean>;
}
