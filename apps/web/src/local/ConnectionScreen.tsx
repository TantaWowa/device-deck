import React, { useEffect, useState } from "react";
import { ChevronDown, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { Brand } from "../../../../packages/ui/src";
import "./connection-screen.css";

export function ConnectionScreen({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(Boolean(error));
  useEffect(() => { if (error) setExpanded(true); }, [error]);

  return <main className="live-loading connection-screen" aria-label="Device Deck connection">
    <Brand />
    <section className={`connection-card${error ? " connection-failed" : ""}`}>
      <div className="connection-status" role={error ? "alert" : "status"}>
        <span className="connection-icon" aria-hidden="true">
          {error ? <CircleAlert size={30} /> : <LoaderCircle className="connection-spinner" size={30} />}
        </span>
        <div><h1>{error ? "Couldn't connect to Device Deck" : "Connecting to Device Deck"}</h1>
          <p>{error ? "Check the connection details below, then try again." : "Opening your device workspace…"}</p>
        </div>
      </div>
      <div className="connection-actions">
        {error && <button type="button" className="connection-retry" onClick={() => location.reload()}><RefreshCw size={16} />Try again</button>}
        <button type="button" className="connection-more" aria-expanded={expanded} aria-controls="connection-details" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Less info" : "More info"}<ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      <section id="connection-details" className="connection-details" hidden={!expanded} aria-label="Connection details">
        <h2>Connection details</h2>
        {error && <p className="connection-error-detail">{error}</p>}
        <p>{error ? "Make sure the host Mac is running and reachable." : "Still waiting? Make sure the host Mac is running and reachable. Connecting will continue while you check."}</p>
        <p>On the host Mac, start Device Deck and open a fresh dashboard link:</p>
        <pre>devdeck start{"\n"}devdeck ui</pre>
      </section>
    </section>
  </main>;
}
