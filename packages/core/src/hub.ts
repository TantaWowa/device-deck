import { z } from 'zod';

/** Browser-safe contracts shared by the portal, cloud registry and machine daemon. */
export const publicKeySchema = z.object({
  kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type HubPublicKey = z.infer<typeof publicKeySchema>;

export const endpointSchema = z.string().trim().max(2048).transform((value, ctx) => {
  try {
    if (!/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || ['0.0.0.0', '[::]'].includes(url.hostname) ||
        (url.pathname !== '/' && url.pathname !== '')) throw new Error();
    return url.origin;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an http:// or https:// machine address with an optional port, without a path or credentials.' });
    return z.NEVER;
  }
});
export const machineIdSchema = z.string().uuid();
export const machineIdentitySchema = z.object({
  id: machineIdSchema, name: z.string().min(1).max(120), version: z.string(), publicKey: publicKeySchema,
});
export type MachineIdentity = z.infer<typeof machineIdentitySchema>;

/** Pairing links only use a trusted portal origin, never an arbitrary URL. */
export const portalOriginSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}, 'Use a canonical HTTPS portal origin, or loopback HTTP for development.');
const accountUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return portalOriginSchema.safeParse(url.origin).success && value === `${url.origin}/app/`;
  } catch { return false; }
}, 'Use the portal account home address.');
export const machinePairingStatusSchema = z.discriminatedUnion('paired', [
  z.object({ paired: z.literal(false) }).strict(),
  z.object({ paired: z.literal(true), accountUrl: accountUrlSchema }).strict(),
]);
export type MachinePairingStatus = z.infer<typeof machinePairingStatusSchema>;

export const machineRecordSchema = machineIdentitySchema.omit({ version: true }).extend({
  endpoint: endpointSchema, pairingId: z.string().uuid(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type MachineRecord = z.infer<typeof machineRecordSchema>;
export const machinesResponseSchema = z.object({ machines: z.array(machineRecordSchema) });
export const pairingRequestSchema = z.object({ machineId: machineIdSchema, publicKey: publicKeySchema }).strict();
export const pairMachineRequestSchema = z.object({ code: z.string().min(1).max(64), token: z.string().min(1).max(8192) }).strict();
export const createMachineSchema = z.object({ name: z.string().trim().min(1).max(120), endpoint: endpointSchema, receipt: z.string().min(1).max(8192) }).strict();
export const updateMachineSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), endpoint: endpointSchema.optional() }).strict().refine(value => Object.keys(value).length > 0, 'Provide a name or endpoint.');
export const grantSchema = z.object({ token: z.string(), expiresAt: z.string().datetime() });
export type MachineGrant = z.infer<typeof grantSchema>;
export const pairingResponseSchema = grantSchema.extend({ pairingId: z.string().uuid() });
export const publicKeyResponseSchema = z.object({ issuer: endpointSchema, publicKey: publicKeySchema });
export const pairingReceiptSchema = z.object({ receipt: z.string() });

export const hubClaimsSchema = z.object({
  uid: z.string().min(1).max(128), machineId: machineIdSchema,
  pairingId: z.string().uuid(), purpose: z.enum(['pair', 'paired', 'access']),
});
export type HubClaims = z.infer<typeof hubClaimsSchema>;
export const PAIRING_TTL_SECONDS = 300;
export const ACCESS_TTL_SECONDS = 60;
