import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  ACCESS_TTL_SECONDS, PAIRING_TTL_SECONDS, createMachineSchema, endpointSchema,
  machineIdSchema, pairingRequestSchema, updateMachineSchema,
} from "../../../packages/core/src/hub";
import { CloudError } from "./errors";
import { publicEd25519Key, verifyPairingReceipt, type PortalSigner } from "./signing";
import type { MachineStore } from "./store";

export function canonicalEndpoint(input: string): string {
  return parse(endpointSchema, input);
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new CloudError(400, result.error.issues[0]?.message || "Invalid request.");
  return result.data;
}

export class CloudService {
  constructor(
    private readonly store: MachineStore,
    private readonly signer: PortalSigner,
    private readonly clock = Date.now,
  ) {}

  publicKey() { return { issuer: this.signer.issuer, publicKey: this.signer.publicKey }; }

  async listMachines(uid: string) { return { machines: await this.store.listMachines(uid) }; }

  async getMachine(uid: string, machineId: string) {
    parse(machineIdSchema, machineId);
    const machine = await this.store.getMachine(uid, machineId);
    if (!machine) throw new CloudError(404, "Machine not found.");
    return { machine };
  }

  async beginPairing(uid: string, input: unknown) {
    const { machineId, publicKey: rawKey } = parse(pairingRequestSchema, input);
    const publicKey = publicEd25519Key(rawKey);
    const now = this.clock(), pairingId = randomUUID();
    const expiresAt = new Date(Math.floor(now / 1000) * 1000 + PAIRING_TTL_SECONDS * 1000).toISOString();
    const token = await this.signer.sign({ uid, machineId, pairingId, purpose: "pair" }, now, PAIRING_TTL_SECONDS);
    await this.store.createPairing(uid, { id: pairingId, machineId, publicKey, expiresAt });
    return { token, pairingId, expiresAt };
  }

  async completePairing(uid: string, input: unknown) {
    const data = parse(createMachineSchema, input), endpoint = data.endpoint;
    let pairingId: string;
    try { pairingId = parse(machineIdSchema, decodeJwt(data.receipt).pairingId); }
    catch { throw new CloudError(401, "The machine pairing receipt is invalid or expired."); }
    // The unverified ID only selects a pending record belonging to the authenticated user.
    const pending = await this.store.getPairing(uid, pairingId), now = this.clock();
    if (!pending || Date.parse(pending.expiresAt) <= now)
      throw new CloudError(409, "Pairing expired or was already used. Start pairing again.");
    await verifyPairingReceipt(data.receipt, pending.publicKey, {
      uid, machineId: pending.machineId, pairingId, portalOrigin: this.signer.issuer,
    }, now);
    const machine = await this.store.completePairing(uid, pending, {
      name: data.name, endpoint,
    }, new Date(now).toISOString());
    return { machine };
  }

  async updateMachine(uid: string, machineId: string, input: unknown) {
    parse(machineIdSchema, machineId);
    const data = parse(updateMachineSchema, input);
    const patch = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.endpoint !== undefined ? { endpoint: canonicalEndpoint(data.endpoint) } : {}),
    };
    return { machine: await this.store.updateMachine(uid, machineId, patch, new Date(this.clock()).toISOString()) };
  }

  async deleteMachine(uid: string, machineId: string) {
    parse(machineIdSchema, machineId);
    if (!await this.store.deleteMachine(uid, machineId)) throw new CloudError(404, "Machine not found.");
  }

  async grant(uid: string, machineId: string) {
    const { machine } = await this.getMachine(uid, machineId), now = this.clock();
    return {
      token: await this.signer.sign({ uid, machineId, pairingId: machine.pairingId, purpose: "access" }, now, ACCESS_TTL_SECONDS),
      expiresAt: new Date(Math.floor(now / 1000) * 1000 + ACCESS_TTL_SECONDS * 1000).toISOString(),
    };
  }
}
