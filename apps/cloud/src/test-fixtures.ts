import { generateKeyPairSync, randomUUID } from "node:crypto";
import { importJWK, SignJWT, type JWK } from "jose";
import { CloudError } from "./errors";
import { CloudService } from "./service";
import { createPortalSigner } from "./signing";
import type { MachineRecord, MachineStore, PendingPairing } from "./store";

export class MemoryMachineStore implements MachineStore {
  private machines = new Map<string, MachineRecord>();
  private pairings = new Map<string, PendingPairing>();
  async listMachines(uid: string) { return [...this.machines.entries()].filter(([key]) => key.startsWith(`${uid}/`)).map(([, value]) => structuredClone(value)); }
  async getMachine(uid: string, id: string) { return structuredClone(this.machines.get(`${uid}/${id}`)); }
  async createPairing(uid: string, pairing: PendingPairing) { this.pairings.set(`${uid}/${pairing.id}`, structuredClone(pairing)); }
  async getPairing(uid: string, id: string) { return structuredClone(this.pairings.get(`${uid}/${id}`)); }
  async completePairing(uid: string, pairing: PendingPairing, details: { name: string; endpoint: string }, now: string) {
    const pairingKey = `${uid}/${pairing.id}`, machineKey = `${uid}/${pairing.machineId}`;
    const current = this.pairings.get(pairingKey);
    if (!current || Date.parse(current.expiresAt) <= Date.parse(now)) throw new CloudError(409, "Pairing expired or was already used.");
    const previous = this.machines.get(machineKey);
    const machine = {
      id: pairing.machineId, ...details, publicKey: pairing.publicKey, pairingId: pairing.id,
      createdAt: previous?.createdAt || now, updatedAt: now,
    };
    this.pairings.delete(pairingKey);
    this.machines.set(machineKey, machine);
    return structuredClone(machine);
  }
  async updateMachine(uid: string, id: string, patch: { name?: string; endpoint?: string }, now: string) {
    const key = `${uid}/${id}`, previous = this.machines.get(key);
    if (!previous) throw new CloudError(404, "Machine not found.");
    const machine = { ...previous, ...patch, updatedAt: now };
    this.machines.set(key, machine);
    return structuredClone(machine);
  }
  async deleteMachine(uid: string, id: string) { return this.machines.delete(`${uid}/${id}`); }
}

export const portalOrigin = "https://portal.example.test";
export function keys() {
  const keyPair = generateKeyPairSync("ed25519");
  return {
    privateKey: keyPair.privateKey.export({ format: "jwk" }) as JWK,
    publicKey: keyPair.publicKey.export({ format: "jwk" }),
  };
}

export async function fixture() {
  let now = Date.parse("2026-09-16T12:00:00.000Z");
  const machineKeys = keys(), machineId = randomUUID(), signer = await createPortalSigner(portalOrigin, keys().privateKey);
  const store = new MemoryMachineStore(), service = new CloudService(store, signer, () => now);
  async function receipt(pairingId: string, overrides: Record<string, unknown> = {}, privateKey = machineKeys.privateKey) {
    return new SignJWT({ uid: "alice", machineId, pairingId, purpose: "paired", ...overrides })
      .setProtectedHeader({ alg: "EdDSA" }).setIssuer(machineId).setAudience(portalOrigin)
      .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 300)
      .sign(await importJWK(privateKey, "EdDSA"));
  }
  async function pair(uid = "alice") {
    const pending = await service.beginPairing(uid, { machineId, publicKey: machineKeys.publicKey });
    return service.completePairing(uid, { name: "Studio", endpoint: "https://100.65.0.1:47831", receipt: await receipt(pending.pairingId, { uid }) });
  }
  return { service, store, signer, machineId, machineKeys, receipt, pair, now: () => now, advance: (milliseconds: number) => { now += milliseconds; } };
}
