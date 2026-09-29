import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboardNavigationUrl,
  portalNavigationUrl,
  readDashboardNavigation,
  readPortalNavigation,
} from "./browser-navigation";

test("dashboard navigation round-trips top-level, viewer and capture routes", () => {
  assert.deepEqual(readDashboardNavigation(""), {
    view: "Devices", deviceIds: [], captureId: null,
  });
  assert.deepEqual(readDashboardNavigation("?view=devices&devices=phone%201,roku,phone%201"), {
    view: "Devices", deviceIds: ["phone 1", "roku"], captureId: null,
  });
  assert.deepEqual(readDashboardNavigation("?view=captures&capture=shot%2F1"), {
    view: "Captures", deviceIds: [], captureId: "shot/1",
  });
  assert.equal(
    dashboardNavigationUrl("/", "?view=feeds&layout=grid&sources=one,two", "", {
      view: "Devices", deviceIds: ["phone 1"], captureId: null,
    }),
    "/?view=devices&devices=phone+1",
  );
  assert.equal(
    dashboardNavigationUrl("/deck", "?ref=menu&view=feeds&active=one", "#local", {
      view: "Reports", deviceIds: [], captureId: null,
    }),
    "/deck?ref=menu&view=reports#local",
  );
});

test("dashboard navigation ignores invalid and inapplicable route details", () => {
  assert.deepEqual(readDashboardNavigation("?view=unknown&devices=one&capture=two"), {
    view: "Devices", deviceIds: ["one"], captureId: null,
  });
  assert.deepEqual(readDashboardNavigation("?view=history&devices=one&capture=two"), {
    view: "History", deviceIds: [], captureId: null,
  });
  assert.equal(
    dashboardNavigationUrl("/", "?view=captures&capture=old", "", {
      view: "Captures", deviceIds: [], captureId: "new",
    }),
    "/?view=captures&capture=new",
  );
});

test("portal navigation round-trips machine, tab and capture routes", () => {
  assert.deepEqual(readPortalNavigation(""), {
    machineId: "", view: "feeds", captureId: null,
  });
  assert.deepEqual(readPortalNavigation("#machine=lab%2Fone&view=captures&capture=shot%201"), {
    machineId: "lab/one", view: "captures", captureId: "shot 1",
  });
  assert.deepEqual(readPortalNavigation("#machine=lab&view=invalid&capture=ignored"), {
    machineId: "lab", view: "feeds", captureId: null,
  });
  assert.equal(
    portalNavigationUrl("/app/", "?ref=invite", {
      machineId: "lab/one", view: "devices", captureId: null,
    }),
    "/app/?ref=invite#machine=lab%2Fone&view=devices",
  );
  assert.equal(
    portalNavigationUrl("/app/", "", {
      machineId: "", view: "captures", captureId: "ignored",
    }),
    "/app/",
  );
});
