import { createService } from "./server";
const port = Number(process.env.DEVICE_DECK_PORT || 47831);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("DEVICE_DECK_PORT must be an integer from 1 to 65535.");
const service = createService();
service.listen(port, "127.0.0.1", () =>
  console.error(
    `Device Deck scaffold listening on http://127.0.0.1:${port}. No hardware adapters registered.`,
  ),
);
service.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => service.close());
