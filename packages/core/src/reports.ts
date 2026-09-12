import { z } from "zod";
export const reportRequestSchema = z
  .object({
    preset: z
      .enum(["day", "week", "month", "custom"])
      .optional()
      .describe(
        "Default day. Calendar periods use the daemon Mac timezone; weeks start Monday.",
      ),
    start: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Custom first calendar date, YYYY-MM-DD, inclusive."),
    end: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Custom last calendar date, YYYY-MM-DD, inclusive."),
  })
  .strict();
export type ReportRequest = z.infer<typeof reportRequestSchema>;
export type ReportRange = {
  preset: NonNullable<ReportRequest["preset"]>;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  asOf: number;
  timeZone: string;
};
export const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Use dates in YYYY-MM-DD format.");
  const [y, m, d] = value.split("-").map(Number),
    date = new Date(y, m - 1, d);
  if (
    y < 1970 ||
    y > 9998 ||
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  )
    throw new Error("Choose valid calendar dates from 1970 through 9998.");
  return date;
}
export function resolveReportRange(
  request: ReportRequest = {},
  now = Date.now(),
): ReportRange {
  reportRequestSchema.parse(request);
  const preset =
    request.preset || (request.start || request.end ? "custom" : "day");
  let start = new Date(now);
  start.setHours(0, 0, 0, 0);
  let end = new Date(start);
  if (preset === "custom") {
    if (!request.start || !request.end)
      throw new Error("Choose both a start and end date.");
    start = calendarDate(request.start);
    end = calendarDate(request.end);
    if (start > end)
      throw new Error("Start date must be on or before end date.");
  } else {
    if (request.start || request.end)
      throw new Error("Use Custom with explicit start and end dates.");
    if (preset === "week") {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      end = new Date(start);
      end.setDate(end.getDate() + 6);
    }
    if (preset === "month") {
      start.setDate(1);
      end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    }
  }
  const endDate = localDate(end);
  end.setDate(end.getDate() + 1);
  return {
    preset,
    start: localDate(start),
    end: endDate,
    startMs: start.getTime(),
    endMs: end.getTime(),
    asOf: now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
export type ReportSession = {
  deviceId: string;
  createdAt: number;
  endedAt?: number;
};
export type ReportCapture = {
  deviceId: string;
  createdAt: number;
  status: string;
};
export type UsageReport = {
  range: ReportRange;
  sessions: number;
  reservedMs: number;
  contentions: number;
  captureAttempts: number;
  captureFailures: number;
  byDevice: {
    deviceId: string;
    reservedMs: number;
    sessions: number;
    captureAttempts: number;
    captureFailures: number;
    contentions: number;
  }[];
};
export function aggregateReport(
  range: ReportRange,
  sessions: ReportSession[],
  captures: ReportCapture[],
  contentions: { deviceId: string; at: number }[],
): UsageReport {
  const report: UsageReport = {
    range,
    sessions: 0,
    reservedMs: 0,
    contentions: 0,
    captureAttempts: 0,
    captureFailures: 0,
    byDevice: [],
  };
  const rows = new Map<string, UsageReport["byDevice"][number]>();
  const row = (id: string) => {
    if (!rows.has(id))
      rows.set(id, {
        deviceId: id,
        reservedMs: 0,
        sessions: 0,
        captureAttempts: 0,
        captureFailures: 0,
        contentions: 0,
      });
    return rows.get(id)!;
  };
  const inside = (at: number) =>
    at >= range.startMs && at < range.endMs && at <= range.asOf;
  for (const session of sessions) {
    const ms = Math.max(
      0,
      Math.min(session.endedAt ?? range.asOf, range.asOf, range.endMs) -
        Math.max(session.createdAt, range.startMs),
    );
    if (ms > 0) {
      const d = row(session.deviceId);
      d.reservedMs += ms;
      d.sessions++;
      report.reservedMs += ms;
      report.sessions++;
    }
  }
  for (const capture of captures)
    if (inside(capture.createdAt)) {
      const d = row(capture.deviceId);
      d.captureAttempts++;
      report.captureAttempts++;
      if (["failed", "interrupted"].includes(capture.status)) {
        d.captureFailures++;
        report.captureFailures++;
      }
    }
  for (const event of contentions)
    if (inside(event.at)) {
      row(event.deviceId).contentions++;
      report.contentions++;
    }
  report.byDevice = [...rows.values()].sort(
    (a, b) =>
      b.reservedMs - a.reservedMs || a.deviceId.localeCompare(b.deviceId),
  );
  return report;
}
