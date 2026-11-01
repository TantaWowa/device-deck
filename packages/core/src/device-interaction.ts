import { z } from "zod";
import type { InteractiveSource, VideoProfile } from "./live";

export const appIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const uiReadSchema = z.object({
  maxNodes: z.number().int().min(1).max(2000).default(500),
  maxDepth: z.number().int().min(1).max(40).default(20),
  selector: z.object({ id: z.string().max(256).optional(), label: z.string().max(512).optional(), type: z.string().max(128).optional() }).strict().optional(),
}).strict();
export const deviceLogsSchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  durationMs: z.number().int().min(100).max(5000).default(1000),
  maxBytes: z.number().int().min(256).max(262144).default(65536),
  maxLines: z.number().int().min(1).max(2000).default(500),
  process: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
}).strict().superRefine((value, context) => {
  const end = value.until ? Date.parse(value.until) : Date.now();
  const start = value.since ? Date.parse(value.since) : end - 60000;
  if (start >= end || end - start > 600000 || end > Date.now() + 60000)
    context.addIssue({ code: "custom", message: "Logs require an ordered interval of at most ten minutes, ending no later than the current time." });
});
export type UiRead = z.infer<typeof uiReadSchema>;
export type DeviceLogs = z.infer<typeof deviceLogsSchema>;
export type UiNode = {
  id: string | null; type: string | null; label: string | null; value: string | null;
  enabled: boolean | null; selected: boolean | null; focused: boolean | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  depth: number;
};
export type UiSnapshot = { nodes: UiNode[]; truncated: boolean; coordinateSpace: "points" | "pixels" };
export type InteractionCapabilities = {
  backend: "idb" | "webdriveragent" | "adb-scrcpy" | "roku-ecp" | "apple-tv-companion" | "capture-only";
  ui: boolean; logs: "history" | "live" | false; appState: boolean; appLaunch: boolean;
  notes: string[];
};
export interface DeviceInteraction {
  readonly capabilities: InteractionCapabilities;
  input(value: { key?: string; text?: string; x?: number; y?: number }): Promise<unknown>;
  interactive(control?: boolean, profile?: VideoProfile): Promise<InteractiveSource>;
  screenshot(): Promise<Buffer>;
  ui(options: UiRead): Promise<UiSnapshot>;
  logs(options: DeviceLogs): Promise<{ text: string; truncated: boolean; since: string; until: string }>;
  appState(appId?: string): Promise<Record<string, unknown>>;
  launch(appId: string, args: string[]): Promise<unknown>;
  close(): Promise<void>;
}
