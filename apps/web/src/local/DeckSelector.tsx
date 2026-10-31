import { useEffect, useState } from "react";
import { deckListSchema, type DeckSummary } from "../../../../packages/core/src/decks";
import { activeDeck } from "./api";
import "./deck-selector.css";

export function DeckSelector() {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/v1/decks", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error("Deck connections unavailable");
        setDecks(deckListSchema.parse(await response.json()).decks);
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    })();
    return () => controller.abort();
  }, []);
  return <div className="deck-selector">
    <label>Device host<select aria-label="Device host" value={activeDeck} onChange={(event) => {
      const query = new URLSearchParams({ view: "capture-cards" });
      if (event.target.value !== "local") query.set("deck", event.target.value);
      location.assign(`/?${query}`);
    }}>
      <option value="local">This Mac</option>
      {activeDeck !== "local" && !decks.some((deck) => deck.name === activeDeck) && <option value={activeDeck}>{activeDeck}</option>}
      {decks.map((deck) => <option key={deck.machineId} value={deck.name}>{deck.name}</option>)}
    </select></label>
    <small>{activeDeck === "local" ? "Devices attached to this Mac" : `Reservations and captures stay on ${activeDeck}.`}</small>
    {error && <small role="status">{error}</small>}
  </div>;
}
