import { DeckError, type Source } from "../../../packages/core/src/local/types";

export function selectFeeds(sources: Source[], requested?: string): Source[] {
  if (!requested) {
    const connected = sources.filter(
      (s) => s.kind === "usb" && s.status === "connected",
    );
    if (!connected.length)
      throw new DeckError(
        "arguments",
        "No connected USB feeds. Run devdeck feeds.",
        400,
      );
    return connected;
  }
  const chosen = requested.split(",").map((value) => {
    const name = value.trim().toLowerCase();
    if (!name)
      throw new DeckError(
        "arguments",
        "Supply a feed name or ID for each selection.",
        400,
      );
    const matches = sources.filter(
      (s) =>
        s.kind === "usb" &&
        (s.id.toLowerCase() === name ||
          s.uniqueId?.toLowerCase() === name ||
          s.name.toLowerCase() === name),
    );
    if (matches.length !== 1)
      throw new DeckError(
        "arguments",
        matches.length
          ? `Feed '${value}' is ambiguous. Use its ID from devdeck feeds.`
          : `No USB feed matches '${value}'. Run devdeck feeds.`,
        400,
      );
    return matches[0];
  });
  return [...new Map(chosen.map((s) => [s.id, s])).values()];
}

export function feedQuery(ids: string[], mux: boolean) {
  return new URLSearchParams({
    view: "feeds",
    layout: mux ? "grid" : "single",
    sources: ids.join(","),
  });
}
