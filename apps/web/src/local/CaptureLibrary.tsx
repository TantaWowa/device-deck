import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, Camera, Copy, Download, FolderOpen, Grid2X2, List, Trash2, Undo2, X } from "lucide-react";
import type { Artifact, Operation, Session } from "../../../../packages/core/src/local/types";
import { captureBatches, captureDownloadName, captureIsBusy, captureStorage, emptyCaptureFilters, hasCaptureFilters, formatCaptureBytes, visibleCaptures, visibleCaptureSelection, type CaptureDevice, type CaptureFilters, type CaptureSort, type CaptureSortColumn, type CaptureVariant } from "../../../../packages/core/src/capture-library";
import { CaptureFilters as CaptureFilterBar } from "./CaptureFilters";
import { CaptureThumbnail, type CaptureThumbnailProps } from "./CaptureThumbnail";
import { copyImageToClipboard } from "./capture-feedback";
import "./capture-library.css";

export type CaptureLibraryProps = Pick<CaptureThumbnailProps, "thumbnailUrl" | "getThumbnail"> & {
  artifacts: Artifact[];
  devices: CaptureDevice[];
  sessions?: Session[];
  folder: string;
  operation: <T = unknown>(name: Operation, args?: unknown, signal?: AbortSignal) => Promise<T>;
  getBlob: (artifact: Artifact, variant: CaptureVariant, signal?: AbortSignal) => Promise<Blob>;
  fileUrl?: (artifact: Artifact, variant: CaptureVariant) => string;
  openArtifactId: string | null;
  onOpenArtifact: (id: string | null) => void;
  onChange?: () => Promise<unknown>;
  onNotice?: (message: string) => void;
  onOpenFolder?: () => Promise<unknown>;
};

const emptyFilters = emptyCaptureFilters;
const date = (value: number) => new Date(value).toLocaleString();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusLabel = (status: Artifact["status"]) => status[0].toUpperCase() + status.slice(1);
const columns: { key: CaptureSortColumn; label: string }[] = [
  { key: "name", label: "Name" }, { key: "device", label: "Device" }, { key: "kind", label: "Type" },
  { key: "createdAt", label: "Date" }, { key: "bytes", label: "Size" }, { key: "status", label: "Status" },
];

export function CaptureLibrary(props: CaptureLibraryProps) {
  const { artifacts, devices, folder, operation, getBlob, fileUrl, openArtifactId, onOpenArtifact, onChange, onNotice, onOpenFolder } = props;
  const [filters, setFilters] = useState<CaptureFilters>(emptyFilters);
  const [sort, setSort] = useState<CaptureSort>({ column: "createdAt", direction: "descending" });
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<"tiled" | "list">(() => {
    try { return localStorage.getItem("deck-captures-view") === "list" ? "list" : "tiled"; }
    catch { return "tiled"; }
  });
  useEffect(() => { try { localStorage.setItem("deck-captures-view", view); } catch {} }, [view]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [purgeIds, setPurgeIds] = useState<string[] | null>(null);
  const [storageStats, setStorageStats] = useState<{ bytes: number; libraryBytes: number; trashBytes: number; files: number; missingFiles: number } | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageRevision, setStorageRevision] = useState(0);
  const storageRequest = useRef({ operation, lastAt: 0, revision: -1 });
  storageRequest.current.operation = operation;
  const selectAll = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => visibleCaptures(artifacts, devices, filters, sort, props.sessions), [artifacts, devices, filters, sort, props.sessions]);
  const eligible = visible.filter((artifact) => !captureIsBusy(artifact));
  const selection = visibleCaptureSelection(selected, visible);
  const storage = captureStorage(artifacts);
  const current = artifacts.find((artifact) => artifact.id === openArtifactId && !artifact.purgedAt);
  const currentIndex = visible.findIndex((artifact) => artifact.id === openArtifactId);
  const activeFilters = hasCaptureFilters(filters);
  const selectionKey = JSON.stringify(selection);
  const storageKey = JSON.stringify(artifacts.map(({ id, bytes, deletedAt, purgedAt, status }) => [id, bytes, deletedAt, purgedAt, status]));

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const forced = storageRequest.current.revision !== storageRevision;
    const delay = forced ? 0 : Math.max(0, 30_000 - (Date.now() - storageRequest.current.lastAt));
    const timer = window.setTimeout(() => {
      storageRequest.current.lastAt = Date.now(); storageRequest.current.revision = storageRevision;
      setStorageLoading(true);
      void storageRequest.current.operation<NonNullable<typeof storageStats>>("captures.storage", {}, controller.signal).then((stats) => {
        if (!disposed) { setStorageStats(stats); setStorageLoading(false); }
      }, () => { if (!disposed) { setStorageStats(null); setStorageLoading(false); } });
    }, delay);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [storageKey, storageRevision]);

  useEffect(() => {
    setSelected((previous) => JSON.stringify(previous) === selectionKey ? previous : JSON.parse(selectionKey));
  }, [selectionKey]);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selection.length > 0 && selection.length < eligible.length;
  }, [selection.length, eligible.length]);
  // A completion toast may request a capture outside the current library filters.
  useEffect(() => {
    if (current && currentIndex < 0) setFilters({ ...emptyFilters, trash: Boolean(current.deletedAt) });
  }, [openArtifactId, current?.deletedAt, currentIndex]);

  const announce = (message: string) => { setNotice(message); onNotice?.(message); };
  const run = async (label: string, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(""); setNotice("");
    try { await task(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(""); }
  };
  const download = async (artifact: Artifact, variant: CaptureVariant = "file", signal?: AbortSignal) => {
      let url: string;
      let objectUrl = false;
      if (fileUrl) {
        const link = new URL(fileUrl(artifact, variant), window.location.href);
        link.searchParams.set("download", "1");
        url = link.href;
      } else {
        const blob = await getBlob(artifact, variant, signal);
        signal?.throwIfAborted();
        url = URL.createObjectURL(blob);
        objectUrl = true;
      }
      const link = document.createElement("a");
      link.href = url; link.download = captureDownloadName(artifact, variant);
      document.body.append(link); link.click(); link.remove();
      if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const change = async (kind: "remove" | "restore" | "purge", ids: string[]) => {
    if (!ids.length) return;
    await run(kind === "restore" ? "Restoring captures…" : kind === "purge" ? "Deleting captures…" : "Moving captures to trash…", async () => {
      let completed = 0;
      try {
        for (const batch of captureBatches(ids)) {
          await operation(`captures.${kind}`, { ids: batch, ...(kind !== "restore" ? { confirmed: true } : {}) });
          completed += batch.length;
          setSelected((previous) => previous.filter((id) => !batch.includes(id)));
        }
        if (ids.includes(openArtifactId || "")) onOpenArtifact(null);
        setPurgeIds(null);
        announce(kind === "restore" ? `Restored ${completed} capture${completed === 1 ? "" : "s"}.` : kind === "purge" ? `Permanently deleted ${completed} capture${completed === 1 ? "" : "s"}.` : `Moved ${completed} capture${completed === 1 ? "" : "s"} to trash. Files remain until permanently deleted.`);
      } catch (error) {
        throw new Error(`${completed ? `${completed} captures updated. ` : ""}${errorMessage(error)}`);
      } finally { setStorageRevision((previous) => previous + 1); await onChange?.(); }
    });
  };
  const sortBy = (column: CaptureSortColumn) => setSort((previous) => ({ column, direction: previous.column === column && previous.direction === "ascending" ? "descending" : "ascending" }));

  return <section className="capture-library" aria-label="Capture library" aria-busy={Boolean(busy)}>
    <header className="capture-library-heading">
      <div><h2>{filters.trash ? "Trash" : "Captures"}</h2><p>Browse, download and manage your screenshots and recordings.</p></div>
      <button type="button" className={filters.trash ? "capture-selected-button" : ""} onClick={() => { setFilters((previous) => ({ ...previous, trash: !previous.trash })); setSelected([]); }}><Trash2 size={15} />{filters.trash ? "Back to library" : `Trash (${storage.trash.count})`}</button>
    </header>
    <div className="capture-storage">
      <div><strong>{formatCaptureBytes(storageStats?.libraryBytes ?? storage.library.bytes)}</strong><span>Library · {storage.library.count} captures</span></div>
      <div><strong>{formatCaptureBytes(storageStats?.trashBytes ?? storage.trash.bytes)}</strong><span>Trash · {storage.trash.count} captures</span></div>
      <div className="capture-folder"><span title={folder}>{folder}</span><button type="button" disabled={Boolean(busy)} onClick={() => void run("Opening capture folder…", async () => { await (onOpenFolder ? onOpenFolder() : operation("captures.openFolder", {})); announce("Opened the capture folder in Finder on the host Mac."); })}><FolderOpen size={15} />Open folder on Mac</button></div>
    </div>
    <CaptureFilterBar value={filters} onChange={setFilters} devices={devices} artifacts={artifacts} />
    <div className="capture-view-toolbar">
      <label className="capture-select-all"><input ref={selectAll} type="checkbox" aria-label="Select all visible captures" checked={eligible.length > 0 && selection.length === eligible.length} disabled={!eligible.length || Boolean(busy)} onChange={(event) => setSelected(event.target.checked ? eligible.map((artifact) => artifact.id) : [])} />Select all</label>
      <span className="capture-result-count">{visible.length} {visible.length === 1 ? "capture" : "captures"}</span>
      {view === "tiled" && <div className="capture-sort-controls"><label>Sort by <select aria-label="Sort captures by" value={sort.column} onChange={(event) => setSort((current) => ({ ...current, column: event.target.value as CaptureSortColumn }))}>{columns.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}</select></label><button type="button" aria-label={sort.direction === "ascending" ? "Sort descending" : "Sort ascending"} onClick={() => setSort((current) => ({ ...current, direction: current.direction === "ascending" ? "descending" : "ascending" }))}>{sort.direction === "ascending" ? <ArrowUp size={15} /> : <ArrowDown size={15} />}</button></div>}
      <div className="capture-view-buttons" role="group" aria-label="Capture view"><button type="button" aria-pressed={view === "tiled"} onClick={() => setView("tiled")}><Grid2X2 size={15} />Tiled view</button><button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={15} />List view</button></div>
    </div>
    {(notice || busy) && <p className="capture-library-notice" role="status">{busy || notice}</p>}
    {error && <p className="capture-library-error" role="alert">{error}</p>}
    {selection.length > 0 && <div className="capture-bulk-actions"><strong>{selection.length} selected</strong><button type="button" disabled={Boolean(busy)} onClick={() => void change(filters.trash ? "restore" : "remove", selection)}>{filters.trash ? <Undo2 size={14} /> : <Trash2 size={14} />}{filters.trash ? "Restore selected" : "Move to trash"}</button>{filters.trash && <button type="button" className="capture-danger" disabled={Boolean(busy)} onClick={() => setPurgeIds(selection)}>Delete permanently…</button>}<button type="button" disabled={Boolean(busy)} onClick={() => setSelected([])}>Clear selection</button></div>}
    {view === "list" ? <div className="capture-table-scroll">
      <table className="capture-table">
        <thead><tr><th className="capture-check"><span className="capture-visually-hidden">Select</span></th>{columns.map(({ key, label }) => <th key={key} aria-sort={sort.column === key ? sort.direction : "none"}><button type="button" onClick={() => sortBy(key)}>{label}{sort.column === key ? sort.direction === "ascending" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</button></th>)}<th className="capture-download-col"><span className="capture-visually-hidden">Download</span></th></tr></thead>
        <tbody>{visible.map((artifact) => {
          const device = devices.find((device) => device.id === artifact.deviceId);
          return <tr key={artifact.id} data-capture-id={artifact.id} className={selection.includes(artifact.id) ? "capture-row-selected" : ""}>
            <td className="capture-check"><input type="checkbox" aria-label={`Select ${artifact.name}`} checked={selection.includes(artifact.id)} disabled={captureIsBusy(artifact) || Boolean(busy)} onChange={(event) => setSelected(event.target.checked ? [...selection, artifact.id] : selection.filter((id) => id !== artifact.id))} /></td>
            <td className="capture-name-cell"><button type="button" className="capture-name" aria-label={artifact.name} onClick={() => onOpenArtifact(artifact.id)}><CaptureThumbnail artifact={artifact} thumbnailUrl={props.thumbnailUrl} getThumbnail={props.getThumbnail} /><span>{artifact.name}{artifact.tags.length > 0 && <small className="capture-row-tags">{artifact.tags.join(" · ")}</small>}</span></button></td>
            <td><span className="capture-device-name">{device?.name || artifact.deviceId}</span><small>{device?.platform || "Device removed"}</small></td>
            <td><span className="capture-type">{artifact.kind}</span></td>
            <td><time dateTime={new Date(artifact.createdAt).toISOString()}>{date(artifact.createdAt)}</time></td>
            <td className="capture-size">{formatCaptureBytes(artifact.bytes)}</td>
            <td><span className={`capture-status capture-status-${artifact.status}`} title={artifact.error}>{statusLabel(artifact.status)}</span></td>
            <td className="capture-download-col"><button type="button" className="capture-icon-button" aria-label={`Download ${artifact.name}`} title="Download capture" disabled={Boolean(busy) || Boolean(artifact.deletedAt) || captureIsBusy(artifact)} onClick={() => void run(`Downloading ${artifact.name}…`, () => download(artifact))}><Download size={16} /></button></td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <div className="capture-tiles">
      {visible.map((artifact) => {
        const device = devices.find((device) => device.id === artifact.deviceId);
        return <article key={artifact.id} data-capture-id={artifact.id} className={`capture-tile${selection.includes(artifact.id) ? " capture-tile-selected" : ""}`}>
          <div className="capture-tile-image">
            <button type="button" className="capture-tile-preview" aria-label={`Preview ${artifact.name}`} onClick={() => onOpenArtifact(artifact.id)}><CaptureThumbnail artifact={artifact} thumbnailUrl={props.thumbnailUrl} getThumbnail={props.getThumbnail} /></button>
            <input className="capture-tile-select" type="checkbox" aria-label={`Select ${artifact.name}`} checked={selection.includes(artifact.id)} disabled={captureIsBusy(artifact) || Boolean(busy)} onChange={(event) => setSelected(event.target.checked ? [...selection, artifact.id] : selection.filter((id) => id !== artifact.id))} />
            <span className="capture-tile-kind">{artifact.kind === "recording" ? `Video${artifact.duration ? ` · ${Math.floor(artifact.duration / 60)}:${String(Math.floor(artifact.duration) % 60).padStart(2, "0")}` : ""}` : "Screenshot"}</span>
          </div>
          <div className="capture-tile-details"><button type="button" className="capture-tile-title" onClick={() => onOpenArtifact(artifact.id)}>{artifact.name}</button><p>{device?.name || artifact.deviceId}{device ? ` · ${device.platform}` : " · Device removed"}</p><time dateTime={new Date(artifact.createdAt).toISOString()}>{date(artifact.createdAt)}</time>{artifact.tags.length > 0 && <span className="capture-tile-tags">{artifact.tags.join(" · ")}</span>}
            <footer><span className={`capture-status capture-status-${artifact.status}`} title={artifact.error}>{statusLabel(artifact.status)}</span><span>{formatCaptureBytes(artifact.bytes)}</span><button type="button" aria-label={`Download ${artifact.name}`} title="Download capture" disabled={Boolean(busy) || Boolean(artifact.deletedAt) || captureIsBusy(artifact)} onClick={() => void run(`Downloading ${artifact.name}…`, () => download(artifact))}><Download size={16} /></button></footer>
          </div>
        </article>;
      })}
    </div>}
    {!visible.length && <div className="capture-empty"><Camera size={25} /><strong>{filters.search || activeFilters ? "No captures match these filters" : filters.trash ? "Trash is empty" : "Your captures will appear here"}</strong><p>{filters.search || activeFilters ? "Try another search or clear the filters." : filters.trash ? "Captures moved to trash can be restored or permanently deleted here." : "Take a screenshot or record a device from a feed or remote."}</p></div>}
    <p className="capture-storage-note">{storageStats ? `${formatCaptureBytes(storageStats.bytes)} total across ${storageStats.files} managed files, including clean originals and logs.${storageStats.missingFiles ? ` ${storageStats.missingFiles} files are missing.` : ""}` : `Media sizes shown; ${storageLoading ? "calculating total storage…" : "total storage is unavailable. Clean originals and logs may use additional space."}`}</p>
    {current && <CapturePreviewModal artifact={current} deviceName={devices.find((device) => device.id === current.deviceId)?.name || current.deviceId} index={currentIndex} count={visible.length} previous={currentIndex > 0 ? () => onOpenArtifact(visible[currentIndex - 1].id) : undefined} next={currentIndex >= 0 && currentIndex < visible.length - 1 ? () => onOpenArtifact(visible[currentIndex + 1].id) : undefined} close={() => onOpenArtifact(null)} getBlob={getBlob} fileUrl={fileUrl} download={download} operation={operation} onChange={onChange} onNotice={announce} />}
    {purgeIds && <CapturePurgeDialog count={purgeIds.length} busy={Boolean(busy)} error={error} close={() => !busy && setPurgeIds(null)} confirm={() => void change("purge", purgeIds)} />}
  </section>;
}

type CapturePreviewProps = Pick<CaptureLibraryProps, "getBlob" | "fileUrl" | "operation" | "onChange" | "onNotice"> & {
  artifact: Artifact; deviceName: string; index: number; count: number;
  previous?: () => void; next?: () => void; close: () => void;
  download: (artifact: Artifact, variant?: CaptureVariant, signal?: AbortSignal) => Promise<void>;
};

export function CapturePreviewModal({ artifact, deviceName, index, count, previous, next, close, getBlob, fileUrl, download, operation, onChange, onNotice }: CapturePreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState(artifact.name);
  const [tags, setTags] = useState(artifact.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [media, setMedia] = useState<{ id: string; url?: string; error?: string } | null>(null);
  const actionGeneration = useRef(0);
  const latest = useRef({ previous, next, close, saving, getBlob, fileUrl });
  latest.current = { previous, next, close, saving, getBlob, fileUrl };
  const canPreview = !artifact.deletedAt && !captureIsBusy(artifact);
  const activeMedia = media?.id === artifact.id ? media : null;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useLayoutEffect(() => {
    actionGeneration.current++;
    setCopying(false); setDownloading(false); setError(""); setMessage("");
    return () => {
      actionGeneration.current++;
    };
  }, [artifact.id]);
  useEffect(() => {
    setName(artifact.name); setTags(artifact.tags.join(", "));
  }, [artifact.id, artifact.name, artifact.tags.join(", ")]);
  useEffect(() => {
    if (!canPreview) { setMedia(null); return; }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let disposed = false;
    setMedia({ id: artifact.id });
    const direct = latest.current.fileUrl?.(artifact, "file");
    if (direct) setMedia({ id: artifact.id, url: direct });
    else void latest.current.getBlob(artifact, "file", controller.signal).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob); setMedia({ id: artifact.id, url: objectUrl });
    }, (error) => { if (!disposed) setMedia({ id: artifact.id, error: errorMessage(error) }); });
    return () => { disposed = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.id, artifact.path, canPreview]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)) return;
      if (event.ctrlKey || event.altKey || event.metaKey || latest.current.saving) return;
      const navigate = event.key === "ArrowLeft" ? latest.current.previous : latest.current.next;
      if (navigate) { event.preventDefault(); event.stopPropagation(); navigate(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      await operation("captures.edit", { id: artifact.id, name: name.trim(), tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) });
      await onChange?.(); setMessage("Details saved."); onNotice?.("Capture details saved.");
    } catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  };
  const copy = async () => {
    const generation = actionGeneration.current;
    setCopying(true); setError(""); setMessage("");
    try { await copyImageToClipboard(() => getBlob(artifact, "file")); if (generation === actionGeneration.current) setMessage("Screenshot copied to clipboard."); }
    catch (error) { if (generation === actionGeneration.current) setError(errorMessage(error)); }
    finally { if (generation === actionGeneration.current) setCopying(false); }
  };
  const downloadCurrent = async (variant: CaptureVariant = "file") => {
    const generation = actionGeneration.current;
    setDownloading(true); setError(""); setMessage("Downloading capture…");
    // A requested download continues while the user browses other captures.
    try { await download(artifact, variant); if (generation === actionGeneration.current) setMessage("Download started."); }
    catch (error) { if (generation === actionGeneration.current) { setMessage(""); setError(errorMessage(error)); } }
    finally { if (generation === actionGeneration.current) setDownloading(false); }
  };
  return <dialog ref={dialog} className="capture-preview-modal" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!saving) close(); }}>
    <header><div><h2 id={titleId}>Capture preview</h2><span>{index >= 0 ? `${index + 1} of ${count}` : "Capture details"} · {deviceName}</span></div><nav aria-label="Browse captures"><button type="button" aria-label="Previous capture" title="Previous capture (left arrow)" disabled={!previous || saving} onClick={previous}><ArrowLeft size={18} /></button><button type="button" aria-label="Next capture" title="Next capture (right arrow)" disabled={!next || saving} onClick={next}><ArrowRight size={18} /></button><button type="button" aria-label="Close capture preview" disabled={saving} onClick={close}><X size={19} /></button></nav></header>
    <div className="capture-preview-body">
      <div className="capture-preview-media">
        {!canPreview ? <p>{artifact.deletedAt ? "Restore this capture to preview or download its files." : "Preview will be available when the capture finishes."}</p> : activeMedia?.error ? <p role="alert">Preview unavailable: {activeMedia.error}</p> : activeMedia?.url ? artifact.kind === "recording" ? <video src={activeMedia.url} controls playsInline preload="metadata" onError={() => setMedia({ id: artifact.id, error: "The video could not be loaded." })} /> : <img src={activeMedia.url} alt={artifact.name} onError={() => setMedia({ id: artifact.id, error: "The image could not be loaded." })} /> : <p role="status">Loading preview…</p>}
      </div>
      <div className="capture-preview-details">
        <p className="capture-preview-summary">{statusLabel(artifact.status)} · {artifact.kind} · {formatCaptureBytes(artifact.bytes)}<br />{date(artifact.createdAt)}{artifact.kind === "recording" && artifact.duration > 0 ? ` · ${Math.floor(artifact.duration / 60)}m ${Math.floor(artifact.duration) % 60}s` : ""}</p>
        {artifact.error && <p className="capture-library-error" role="alert">{artifact.error}</p>}
        <form onSubmit={save}><label>Name<input value={name} maxLength={180} required disabled={saving || captureIsBusy(artifact)} onChange={(event) => setName(event.target.value)} /></label><label>Tags<span className="capture-input-help">Separate tags with commas</span><input value={tags} disabled={saving || captureIsBusy(artifact)} onChange={(event) => setTags(event.target.value)} /></label><button type="submit" className="capture-selected-button" disabled={saving || captureIsBusy(artifact) || !name.trim()}>{saving ? "Saving…" : "Save details"}</button></form>
        {canPreview && <div className="capture-preview-downloads"><button type="button" disabled={downloading} onClick={() => void downloadCurrent()}><Download size={15} />Download file</button>{artifact.kind === "screenshot" && <button type="button" disabled={copying} onClick={() => void copy()}><Copy size={15} />{copying ? "Copying…" : "Copy image"}</button>}{artifact.cleanPath && <button type="button" disabled={downloading} onClick={() => void downloadCurrent("clean")}>Clean original</button>}<button type="button" disabled={downloading} onClick={() => void downloadCurrent("log")}>Key log / metadata</button></div>}
        {message && <p className="capture-library-notice" role="status">{message}</p>}{error && <p className="capture-library-error" role="alert">{error}</p>}
        <details className="capture-file-details"><summary>File location</summary><p>{artifact.path}</p></details>
      </div>
    </div>
  </dialog>;
}

function CapturePurgeDialog({ count, busy, error, close, confirm }: { count: number; busy: boolean; error: string; close: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="capture-purge-modal" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }}><h2 id={titleId}>Permanently delete {count} capture{count === 1 ? "" : "s"}?</h2><p>This deletes the capture files, clean originals and logs from the host machine. This cannot be undone.</p>{error && <p className="capture-library-error" role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="button" className="capture-danger" disabled={busy} onClick={confirm}>{busy ? "Deleting…" : "Delete permanently"}</button></footer></dialog>;
}
