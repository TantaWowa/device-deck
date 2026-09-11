export async function callService(path: "health" | "inventory") {
  const port = Number(process.env.DEVICE_DECK_PORT || 47831);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid DEVICE_DECK_PORT.");
  const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Device Deck service returned ${response.status}`);
  return response.json();
}
