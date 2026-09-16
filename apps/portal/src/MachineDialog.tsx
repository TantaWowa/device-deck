import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, Link, Monitor, X } from "lucide-react";
import {
  machineIdentitySchema, pairingReceiptSchema, pairingResponseSchema, type MachineRecord,
} from "../../../packages/core/src/hub";
import { normalizeMachineEndpoint } from "../../../packages/machine-client/src";
import { connectionMessage, endpointInput, needsStandalone } from "./model";
import type { CloudClient } from "./cloud";

async function directJson(endpoint: string, route: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(`${endpoint}${route}`, {
    method: body === undefined ? "GET" : "POST", credentials: "omit", cache: "no-store", redirect: "error", signal,
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Device-Deck": "local" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "The machine rejected this pairing request.");
  return result;
}

export function MachineDialog({ machine, cloud, onSaved, onClose }: {
  machine?: MachineRecord; cloud: CloudClient; onSaved: () => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef(new AbortController());
  const [name, setName] = useState(machine?.name || "");
  const [endpoint, setEndpoint] = useState(machine?.endpoint || "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  let canonical = "";
  try { canonical = normalizeMachineEndpoint(endpointInput(endpoint)); } catch { /* Validated on submit. */ }
  const standalone = canonical && needsStandalone(canonical, location.protocol);
  useEffect(() => {
    dialog.current?.showModal();
    return () => { controller.current.abort(); };
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(""); setBusy(true);
    const signal = AbortSignal.any([controller.current.signal, AbortSignal.timeout(25_000)]);
    try {
      const address = normalizeMachineEndpoint(endpointInput(endpoint));
      if (machine) {
        if (address !== machine.endpoint && !needsStandalone(address, location.protocol)) {
          setStep("Checking the new address…");
          const identity = machineIdentitySchema.parse(await directJson(address, "/v1/machine", signal));
          if (identity.id !== machine.id || JSON.stringify(identity.publicKey) !== JSON.stringify(machine.publicKey))
            throw new Error("That address belongs to a different machine. Add it separately with its pairing code.");
        }
        setStep("Saving changes…");
        await cloud(`/machines/${encodeURIComponent(machine.id)}`, { method: "PATCH", body: { name: name.trim(), endpoint: address }, signal });
      } else {
        if (needsStandalone(address, location.protocol)) throw new Error("Use a trusted HTTPS address to pair from this portal. You can open the HTTP address as a standalone page.");
        setStep("Checking the machine…");
        const identity = machineIdentitySchema.parse(await directJson(address, "/v1/machine", signal));
        setStep("Preparing your pairing…");
        const pairing = pairingResponseSchema.parse(await cloud("/pairings", { method: "POST", body: { machineId: identity.id, publicKey: identity.publicKey }, signal }));
        setStep("Verifying the pairing code…");
        const { receipt } = pairingReceiptSchema.parse(await directJson(address, "/v1/hub/pair", signal, { code: code.trim(), token: pairing.token }));
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        setStep("Adding your machine…");
        await cloud("/machines", { method: "POST", body: { name: name.trim() || identity.name, endpoint: address, receipt }, signal });
      }
      setCode("");
      await onSaved();
      onClose();
    } catch (failure) {
      if (!controller.current.signal.aborted) setError(connectionMessage(failure));
    } finally { setBusy(false); setStep(""); }
  };
  return <dialog ref={dialog} className="portal-dialog" onCancel={onClose}>
    <header><span className="dialog-icon"><Monitor size={23} /></span><button className="icon-button" aria-label="Close machine form" onClick={onClose}><X size={21} /></button></header>
    <h2>{machine ? "Machine settings" : "Add your machine"}</h2>
    <p>{machine ? "Give it a familiar name and keep its address up to date." : "Pair once. Then open its feeds and remotes from any of your browsers."}</p>
    <form onSubmit={(event) => void submit(event)}>
      <label>Machine name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Studio Mac" maxLength={120} required={Boolean(machine)} disabled={busy} /></label>
      <label>Machine address<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://studio.example.com:47831" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={busy} /><small>Hostname or IP address, with a port if needed. HTTPS is used when no scheme is entered.</small></label>
      {!machine && <><div className="pairing-instructions"><Link size={20} /><div><strong>Get a pairing code on your machine</strong><p>Run <code>devdeck pair</code> in its terminal. Paste the current code below.</p></div></div><label>Pairing code<input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Enter the code from Device Deck" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} maxLength={64} required disabled={busy} /></label></>}
      {standalone ? <div className="notice">HTTP addresses open separately. Trusted HTTPS is required for reliable feeds and controls inside this portal, including on phones.<a href={`${canonical}/`} target="_blank" rel="noreferrer">Open standalone <ExternalLink size={14} /></a></div> : <p className="field-note">Your browser connects directly. Keep both devices on the same network or VPN, and allow Local Network access if your browser asks.</p>}
      {error && <div className="notice error" role="alert">{error}{canonical && <a href={`${canonical}/`} target="_blank" rel="noreferrer">Check machine address <ExternalLink size={14} /></a>}</div>}
      {step && <p role="status" className="field-note">{step}</p>}
      <footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || (!machine && Boolean(standalone))}>{busy ? "Working…" : machine ? "Save changes" : "Pair machine"}</button></footer>
    </form>
  </dialog>;
}
