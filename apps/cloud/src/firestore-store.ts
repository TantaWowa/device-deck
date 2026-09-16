import type { Firestore } from "firebase-admin/firestore";
import { CloudError } from "./errors";
import type { MachineRecord, MachineStore, PendingPairing } from "./store";

export class FirestoreMachineStore implements MachineStore {
  constructor(private readonly db: Firestore) {}

  private machines(uid: string) { return this.db.collection("users").doc(uid).collection("machines"); }
  private pairings(uid: string) { return this.db.collection("users").doc(uid).collection("pairings"); }

  async listMachines(uid: string): Promise<MachineRecord[]> {
    const snapshot = await this.machines(uid).orderBy("createdAt", "desc").get();
    return snapshot.docs.map((document) => document.data() as MachineRecord);
  }

  async getMachine(uid: string, machineId: string): Promise<MachineRecord | undefined> {
    const snapshot = await this.machines(uid).doc(machineId).get();
    return snapshot.exists ? snapshot.data() as MachineRecord : undefined;
  }

  async createPairing(uid: string, pairing: PendingPairing): Promise<void> {
    await this.pairings(uid).doc(pairing.id).create({
      ...pairing,
      // Firestore TTL uses a timestamp field; authorization also checks expiresAt itself.
      deleteAfter: new Date(pairing.expiresAt),
    });
  }

  async getPairing(uid: string, pairingId: string): Promise<PendingPairing | undefined> {
    const snapshot = await this.pairings(uid).doc(pairingId).get();
    if (!snapshot.exists) return undefined;
    const value = snapshot.data() as PendingPairing;
    return { id: value.id, machineId: value.machineId, publicKey: value.publicKey, expiresAt: value.expiresAt };
  }

  async completePairing(
    uid: string,
    pairing: PendingPairing,
    details: { name: string; endpoint: string },
    now: string,
  ): Promise<MachineRecord> {
    const pendingRef = this.pairings(uid).doc(pairing.id);
    const machineRef = this.machines(uid).doc(pairing.machineId);
    return this.db.runTransaction(async (transaction) => {
      const [pending, previous] = await Promise.all([transaction.get(pendingRef), transaction.get(machineRef)]);
      const current = pending.data() as PendingPairing | undefined;
      if (
        !current || Date.parse(current.expiresAt) <= Date.parse(now) ||
        current.machineId !== pairing.machineId || current.publicKey.x !== pairing.publicKey.x
      ) throw new CloudError(409, "Pairing expired or was already used. Start pairing again.");
      const machine: MachineRecord = {
        id: pairing.machineId, ...details,
        publicKey: pairing.publicKey, pairingId: pairing.id,
        createdAt: previous.exists ? (previous.data() as MachineRecord).createdAt : now,
        updatedAt: now,
      };
      transaction.delete(pendingRef);
      transaction.set(machineRef, machine);
      return machine;
    });
  }

  async updateMachine(
    uid: string,
    machineId: string,
    patch: { name?: string; endpoint?: string },
    now: string,
  ): Promise<MachineRecord> {
    const ref = this.machines(uid).doc(machineId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new CloudError(404, "Machine not found.");
      const machine: MachineRecord = { ...snapshot.data() as MachineRecord, ...patch, updatedAt: now };
      transaction.set(ref, machine);
      return machine;
    });
  }

  async deleteMachine(uid: string, machineId: string): Promise<boolean> {
    const ref = this.machines(uid).doc(machineId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      transaction.delete(ref);
      return true;
    });
  }
}
