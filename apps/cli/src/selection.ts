import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { callOperation } from "../../../packages/core/src/client";
import {
  matchDevices,
  selectorSchema,
  DeckError,
  type Selector,
  type Snapshot,
  type Device,
} from "../../../packages/core/src/local/types";
export async function pick(
  selector: Selector,
  interactive = true,
): Promise<Device> {
  const snapshot: Snapshot = await callOperation("inventory");
  const eligible = matchDevices(snapshot.devices, snapshot.sessions, selector);
  let candidates = eligible;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length)
    throw new Error(
      "No devices match. Discover and register a device or clear filters.",
    );
  if (!interactive || !stdin.isTTY)
    throw new Error(
      "Ambiguous selector. Supply --device with one friendly name or ID.",
    );
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      console.log(
        candidates
          .map(
            (d, i) =>
              `${i + 1}. ${d.name} | ${d.platform} | ${d.online ? "online" : "offline"} | ${d.locked ? "locked" : snapshot.sessions.find((s) => s.deviceId === d.id && s.state !== "closed")?.owner || "free"}`,
          )
          .join("\n"),
      );
      const answer = (
        await rl.question("Device number, or filter text/platform: ")
      ).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && candidates[index])
        return candidates[index];
      candidates = eligible.filter((d) =>
        `${d.name} ${d.platform}`.toLowerCase().includes(answer.toLowerCase()),
      );
      if (!candidates.length) {
        console.log("No matches.");
        candidates = eligible;
      }
    }
  } finally {
    rl.close();
  }
}
export function parseSelector(values: Record<string, unknown>): Selector {
  const platform =
    typeof values.platform === "string"
      ? (
          { roku: "Roku", android: "Android", apple: "Apple" } as Record<
            string,
            string
          >
        )[values.platform.toLowerCase()] || values.platform
      : undefined;
  const result = selectorSchema.safeParse({
    device: values.device,
    name: values.name,
    platform,
    kind: values.kind,
    formFactor: values["form-factor"],
    tags:
      typeof values.tags === "string"
        ? values.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
        : undefined,
    state:
      typeof values.state === "string" ? values.state.toLowerCase() : undefined,
    capabilities:
      typeof values.capabilities === "string"
        ? values.capabilities.split(",").map((s) => s.trim().toLowerCase())
        : undefined,
  });
  if (!result.success)
    throw new DeckError(
      "arguments",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}
