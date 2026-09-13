export {};
// Runs against the authenticated server; never opens a second SQLite worker.
const [command = "help", ...args] = process.argv.slice(2);
if (command === "help") {
  console.log(
    `Device Deck billing operator\nSet DEVICE_DECK_BILLING_PUBLIC_URL and DEVICE_DECK_BILLING_ADMIN_SECRET.\nCommands:\n  status\n  reconcile <subscription-id>\n  retrieval-grant <subscription-id>\n  hold <subscription-id> <case-reference> <reason>\n  release-hold <resource> <reason>\nRetrieval links are private, expire after 30 minutes and are never sent automatically.`,
  );
} else {
  const base = new URL(
    process.env.DEVICE_DECK_BILLING_OPERATOR_URL ||
      process.env.DEVICE_DECK_BILLING_PUBLIC_URL ||
      "http://127.0.0.1:8080",
  );
  if (
    base.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(base.hostname)
  )
    throw new Error("Use HTTPS or loopback");
  const token = process.env.DEVICE_DECK_BILLING_ADMIN_SECRET;
  if (!token) throw new Error("Missing DEVICE_DECK_BILLING_ADMIN_SECRET");
  let body: unknown;
  if (command === "reconcile" || command === "retrieval-grant") {
    if (args.length !== 1) throw new Error("Expected subscription id");
    body = { subscription: args[0] };
  } else if (command === "hold") {
    if (args.length !== 3)
      throw new Error("Expected subscription id, reference, quoted reason");
    body = { subscription: args[0], reference: args[1], reason: args[2] };
  } else if (command === "release-hold") {
    if (args.length !== 2)
      throw new Error("Expected resource and quoted reason");
    body = { resource: args[0], reason: args[1] };
  } else if (command !== "status" || args.length)
    throw new Error("Unknown command; run help");
  const response = await fetch(new URL(`/admin/${command}`, base), {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`Operator request failed (${response.status})`);
  console.log(JSON.stringify(await response.json(), null, 2));
}
