import { z } from "zod";
import { endpointSchema } from "./hub";

export const deckNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).refine((name) => name !== "local", "local is reserved for this Mac.");
export const deckConnectionSchema = z.object({
  name: deckNameSchema,
  address: endpointSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export const deckSummarySchema = deckConnectionSchema.omit({ token: true }).extend({ machineId: z.string().uuid() });
export type DeckSummary = z.infer<typeof deckSummarySchema>;
export const deckListSchema = z.object({ decks: z.array(deckSummarySchema) });

export function deckRoute(route: string, deck?: string) {
  return deck && deck !== "local" ? `/v1/decks/${deckNameSchema.parse(deck)}${route}` : route;
}

export function deckLeaseStorageKey(deck?: string) {
  return deck && deck !== "local" ? `deck-remote-leases:${encodeURIComponent(deck)}` : "deck-local-leases";
}
