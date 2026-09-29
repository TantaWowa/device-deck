export type DashboardView =
  | "Feeds"
  | "Capture Cards"
  | "Devices"
  | "Captures"
  | "History"
  | "Reports"
  | "Settings"
  | "License";

export type DashboardNavigation = {
  view: DashboardView;
  deviceIds: string[];
  captureId: string | null;
};

const dashboardSlugs: Record<DashboardView, string> = {
  Feeds: "feeds",
  "Capture Cards": "capture-cards",
  Devices: "devices",
  Captures: "captures",
  History: "history",
  Reports: "reports",
  Settings: "settings",
  License: "license",
};

const dashboardViews = new Map(
  Object.entries(dashboardSlugs).map(([view, slug]) => [slug, view as DashboardView]),
);

const navigationKeys = [
  "view",
  "devices",
  "capture",
  "layout",
  "sources",
  "active",
  "deviceType",
] as const;

const ids = (value: string | null) => [
  ...new Set((value || "").split(",").map((id) => id.trim()).filter(Boolean)),
];

export function readDashboardNavigation(search: string): DashboardNavigation {
  const params = new URLSearchParams(search);
  const view = dashboardViews.get(params.get("view") || "devices") || "Devices";
  return {
    view,
    deviceIds: view === "Devices" ? ids(params.get("devices")) : [],
    captureId: view === "Captures" ? params.get("capture") || null : null,
  };
}

export function dashboardNavigationUrl(
  pathname: string,
  currentSearch: string,
  hash: string,
  navigation: DashboardNavigation,
) {
  const params = new URLSearchParams(currentSearch);
  for (const key of navigationKeys) params.delete(key);
  if (navigation.view !== "Devices" || navigation.deviceIds.length)
    params.set("view", dashboardSlugs[navigation.view]);
  if (navigation.view === "Devices" && navigation.deviceIds.length)
    params.set("devices", [...new Set(navigation.deviceIds)].join(","));
  if (navigation.view === "Captures" && navigation.captureId)
    params.set("capture", navigation.captureId);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

export type PortalMachineView = "feeds" | "devices" | "captures";

export type PortalNavigation = {
  machineId: string;
  view: PortalMachineView;
  captureId: string | null;
};

export function readPortalNavigation(hash: string): PortalNavigation {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const machineId = params.get("machine") || "";
  const requestedView = params.get("view");
  const view: PortalMachineView = requestedView === "devices" || requestedView === "captures"
    ? requestedView
    : "feeds";
  return {
    machineId,
    view,
    captureId: machineId && view === "captures" ? params.get("capture") || null : null,
  };
}

export function portalNavigationUrl(
  pathname: string,
  search: string,
  navigation: PortalNavigation,
) {
  const params = new URLSearchParams();
  if (navigation.machineId) {
    params.set("machine", navigation.machineId);
    if (navigation.view !== "feeds") params.set("view", navigation.view);
    if (navigation.view === "captures" && navigation.captureId)
      params.set("capture", navigation.captureId);
  }
  const hash = params.toString();
  return `${pathname}${search}${hash ? `#${hash}` : ""}`;
}
