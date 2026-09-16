import { z } from "zod";

export const gestureCapabilitySchema = z.enum(["tap", "swipe", "longPress", "drag", "multitouch"]);
export type GestureCapability = z.infer<typeof gestureCapabilitySchema>;
export const videoProfileSchema = z.enum(["low", "balanced", "high"]);
export type VideoProfile = z.infer<typeof videoProfileSchema>;
export const videoProfiles = {
  low: { width: 640, fps: 10, bitrate: 500_000 },
  balanced: { width: 1280, fps: 15, bitrate: 1_500_000 },
  high: { width: 1280, fps: 30, bitrate: 4_000_000 },
} as const;
const position = {
  x: z.number().finite().min(0).max(16384),
  y: z.number().finite().min(0).max(16384),
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384),
};
export const pointerInputSchema = z.object({
  type: z.enum(["down", "move", "up", "cancel"]),
  contactId: z.number().int().min(0).max(2147483647),
  ...position,
}).strict().refine((p) => p.type === "cancel" || (p.x < p.width && p.y < p.height), "Pointer is outside the device image.");
export type PointerInput = z.infer<typeof pointerInputSchema>;
export const gestureInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), ...position }).strict(),
  z.object({ type: z.literal("swipe"), ...position, toX: position.x, toY: position.y, durationMs: z.number().int().min(50).max(10000) }).strict(),
  z.object({ type: z.literal("longPress"), ...position, durationMs: z.number().int().min(100).max(10000) }).strict(),
]).refine((p) => p.x < p.width && p.y < p.height && (p.type !== "swipe" || (p.toX < p.width && p.toY < p.height)), "Gesture is outside the device image.");
export type GestureInput = z.infer<typeof gestureInputSchema>;
export const controlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pointer"), event: pointerInputSchema }).strict(),
  z.object({ type: z.literal("gesture"), gesture: gestureInputSchema }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;
/** Receipt on the ordered control channel; all earlier touch messages have
 * reached the server before the browser can dispatch its HTTP hardware key. */
export const inputBarrierSchema = z.object({
  type: z.literal("input-barrier"), id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export const streamOpenSchema = z.object({
  deviceId: z.string().min(1).max(128).optional(),
  sourceId: z.string().min(1).max(160).optional(),
  offer: z.string().min(1).max(128_000),
  profile: videoProfileSchema.default("balanced"),
  control: z.boolean().default(false),
  sessionId: z.string().min(1).optional(),
  leaseToken: z.string().min(1).optional(),
}).strict().refine((a) => Boolean(a.deviceId) !== Boolean(a.sourceId), "Select exactly one device or capture source.")
  .refine((a) => !a.control || Boolean(a.deviceId && a.sessionId && a.leaseToken), "Touch control requires the device's reservation and lease.");
export type StreamOpen = z.infer<typeof streamOpenSchema>;
export const streamCredentialSchema = z.object({ id: z.string().uuid(), token: z.string().min(32).max(128) }).strict();
export type StreamCredentials = z.infer<typeof streamCredentialSchema>;
export type StreamAnswer = StreamCredentials & {
  answer: string;
  capabilities: GestureCapability[];
  supportsInputBarrier?: boolean;
  width: number;
  height: number;
  mode: "live" | "snapshots";
};

/** Server-side media contract. Encoded access units include Annex-B start codes. */
export type H264Frame = { data: Buffer; timestampUs: bigint; keyframe: boolean };
export type LiveVideoSource = {
  readonly width: number;
  readonly height: number;
  readonly fps?: number;
  onFrame(listener: (frame: H264Frame) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
};
export type InteractiveSource = LiveVideoSource & {
  capabilities: GestureCapability[];
  pointer(event: PointerInput): Promise<void>;
  gesture(gesture: GestureInput): Promise<void>;
};
