import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { serviceRequest } from "../../../packages/core/src/client";
import { deckNameSchema } from "../../../packages/core/src/decks";
import { DeckError } from "../../../packages/core/src/local/types";
import { atomicWrite } from "../../../packages/config/src";

export async function decksCommand(action: string, name: string | undefined, options: { address?: string; tokenFile?: string; output?: string }) {
  let route = "/v1/decks", value: unknown;
  if (action === "add") {
    if (!options.address || !options.tokenFile) throw new DeckError("arguments", "Use decks add NAME --address ORIGIN --token-file PRIVATE_FILE.", 400);
    let credential: unknown;
    try { credential = JSON.parse(await readFile(options.tokenFile, "utf8")); }
    catch { throw new DeckError("arguments", "Could not read the private access file created by decks grant.", 400); }
    const token = credential && typeof credential === "object" && "token" in credential ? credential.token : undefined;
    value = { name: deckNameSchema.parse(name), address: options.address, token };
    route += "/add";
  } else if (action === "remove") {
    route += "/remove"; value = { name: deckNameSchema.parse(name) };
  } else if (action === "grant") {
    if (!options.output) throw new DeckError("arguments", "Use decks grant NAME --output PRIVATE_FILE. Transfer this file privately to the connecting Mac.", 400);
    route = "/v1/deck-access/grant"; value = { name: deckNameSchema.parse(name) };
  } else if (action === "revoke") {
    route = "/v1/deck-access/revoke"; value = { id: name };
  } else if (action === "grants") {
    route = "/v1/deck-access/list"; value = {};
  } else if (action !== "list") throw new DeckError("arguments", "Use decks list|add|remove|grant|grants|revoke.", 400);
  const response = await serviceRequest(route, {
    method: value === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    signal: AbortSignal.timeout(200000),
  }, "local");
  const result = await response.json();
  if (!response.ok) throw new DeckError(result.error, result.message, response.status);
  if (action === "grant") {
    await atomicWrite(options.output!, JSON.stringify(result) + "\n");
    return { id: result.id, name: result.name, credentialFile: options.output };
  }
  return result;
}

export async function downloadCapture(id: string | undefined, output: string | undefined) {
  if (!id || !output) throw new DeckError("arguments", "Use download CAPTURE_ID --output FILE [--deck NAME]. Existing files are never overwritten.", 400);
  const response = await serviceRequest(`/v1/artifacts/${encodeURIComponent(id)}/file?download=1`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) {
    const error = await response.json();
    throw new DeckError(error.error, error.message, response.status);
  }
  if (!response.body) throw new DeckError("download-empty", "The host returned no capture file.", 502);
  const file = path.resolve(output);
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) { await response.body.cancel(); throw error; }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      await handle.writeFile(chunk.value);
      bytes += chunk.value.length;
    }
    await handle.sync();
    return { file, bytes };
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  } finally { await handle.close(); await reader.cancel().catch(() => {}); }
}
