import { useEffect, useRef, useState } from "react";
import {
  localDate,
  reportRequestSchema,
  type ReportRequest,
  type UsageReport,
} from "../../../../packages/core/src/reports";
import "./workspace.css";
const duration = (ms: number) =>
  `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m ${Math.floor(ms / 1000) % 60}s`;
export function Reports({
  load,
  devices,
  storageKey,
  demo = false,
}: {
  load: (request: ReportRequest) => Promise<UsageReport> | UsageReport;
  devices: { id: string; name: string }[];
  storageKey: string;
  demo?: boolean;
}) {
  const [request, setRequest] = useState<ReportRequest>(() => {
    try {
      return reportRequestSchema.parse(
        JSON.parse(localStorage.getItem(storageKey) || '{"preset":"day"}'),
      );
    } catch {
      return { preset: "day" };
    }
  });
  const [result, setResult] = useState<{
    key: string;
    report?: UsageReport;
    error?: string;
  } | null>(null);
  const loader = useRef(load);
  loader.current = load;
  const key = JSON.stringify(request);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, key);
    } catch {}
  }, [key, storageKey]);
  useEffect(() => {
    let gone = false;
    let running = false;
    const update = async () => {
      if (running) return;
      running = true;
      try {
        if (request.preset === "custom" && (!request.start || !request.end))
          throw new Error("Choose both a start and end date.");
        const report = await loader.current(request);
        if (!gone) setResult({ key, report });
      } catch (e) {
        if (!gone) setResult({ key, error: (e as Error).message });
      } finally {
        running = false;
      }
    };
    void update();
    const timer = setInterval(update, 10000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [key]);
  const report = result?.key === key ? result.report : undefined,
    error = result?.key === key ? result.error : undefined;
  const chosen = request.preset || (request.start ? "custom" : "day");
  const select = (preset: NonNullable<ReportRequest["preset"]>) =>
    setRequest(
      preset === "custom"
        ? {
            preset,
            start: report?.range.start || localDate(new Date()),
            end: report?.range.end || localDate(new Date()),
          }
        : { preset },
    );
  return (
    <section className="workspace-reports">
      <div className="workspace-heading">
        <h1>Device usage</h1>
        <p>
          {demo
            ? "Seeded report and your simulated demo sessions. No hardware is measured."
            : "Reservation time and capture outcomes recorded on this Mac."}
        </p>
      </div>
      <div className="period-controls">
        <div className="period-buttons" role="group" aria-label="Report period">
          {(
            [
              ["day", "D", "Day"],
              ["week", "W", "Week"],
              ["month", "M", "Month"],
              ["custom", "Custom", "Custom"],
            ] as const
          ).map(([id, short, label]) => (
            <button
              key={id}
              aria-label={label}
              title={label}
              aria-pressed={chosen === id}
              onClick={() => select(id)}
            >
              {short}
            </button>
          ))}
        </div>
        {chosen === "custom" && (
          <div className="period-dates">
            <label>
              Start date
              <input
                type="date"
                min="1970-01-01"
                max="9998-12-31"
                value={request.start || ""}
                onChange={(e) =>
                  setRequest({ ...request, start: e.target.value })
                }
              />
            </label>
            <label>
              End date
              <input
                type="date"
                min="1970-01-01"
                max="9998-12-31"
                value={request.end || ""}
                onChange={(e) =>
                  setRequest({ ...request, end: e.target.value })
                }
              />
            </label>
          </div>
        )}
        <p className="period-caption">
          {report
            ? `${report.range.start} to ${report.range.end} · ${report.range.timeZone}`
            : chosen === "custom"
              ? `${request.start || "Choose start"} to ${request.end || "choose end"}`
              : "Loading calendar dates…"}
        </p>
        <small>
          Whole calendar days. Weeks start Monday. Custom end dates include the
          entire day.
        </small>
      </div>
      {error ? (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      ) : !report ? (
        <p role="status">Loading report…</p>
      ) : (
        <>
          <div className="range-metrics">
            {[
              ["Sessions used", report.sessions],
              ["Reserved time", duration(report.reservedMs)],
              ["Contention events", report.contentions],
              ["Capture attempts", report.captureAttempts],
              ["Failed / interrupted", report.captureFailures],
            ].map(([label, value]) => (
              <article key={label} aria-label={String(label)}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <div className="range-usage">
            <h2>Usage by device</h2>
            {report.byDevice.length ? (
              <div className="workspace-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Reserved time</th>
                      <th>Sessions</th>
                      <th>Captures</th>
                      <th>Failures</th>
                      <th>Contention</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byDevice.map((row) => (
                      <tr key={row.deviceId}>
                        <th scope="row">
                          {devices.find((d) => d.id === row.deviceId)?.name ||
                            row.deviceId}
                        </th>
                        <td>
                          <span>{duration(row.reservedMs)}</span>
                          <meter
                            aria-label={`Reserved time for ${devices.find((d) => d.id === row.deviceId)?.name || row.deviceId}`}
                            min={0}
                            max={Math.max(
                              1,
                              ...report.byDevice.map((r) => r.reservedMs),
                            )}
                            value={row.reservedMs}
                          />
                        </td>
                        <td>{row.sessions}</td>
                        <td>{row.captureAttempts}</td>
                        <td>{row.captureFailures}</td>
                        <td>{row.contentions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="workspace-empty">
                No usage or capture activity in this period. Choose another date
                range.
              </p>
            )}
          </div>
          <p className="report-semantics">
            Sessions used counts reservations with time inside this period. Time
            includes an ongoing reservation only up to this report's refresh.
            Capture attempts and their latest outcomes use capture start time;
            contention uses event time. Removed captures remain counted.
          </p>
          <small className="report-asof">
            Updated {new Date(report.range.asOf).toLocaleString()} ·{" "}
            {report.range.timeZone}
          </small>
        </>
      )}
    </section>
  );
}
