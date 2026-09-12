#!/usr/bin/env node
import { callOperation, browserUrl } from "../../../packages/core/src/client";
import {
  type Snapshot,
  matchDevices,
} from "../../../packages/core/src/local/types";
import { spawn } from "node:child_process";
import { terminal, clean } from "./terminal";
import { interactiveRemote } from "./remote";
let ui = terminal(),
  filter = "",
  index = 0,
  message = "";
try {
  while (true) {
    const snapshot: Snapshot = await callOperation("inventory");
    const rows = matchDevices(snapshot.devices, snapshot.sessions, {
      name: filter,
    });
    index = Math.max(0, Math.min(index, rows.length - 1));
    const width = Math.max(75, Math.min(process.stdout.columns || 100, 150));
    const table = rows
      .map((d, i) => {
        const s = snapshot.sessions.find(
          (s) => s.deviceId === d.id && s.state !== "closed",
        );
        return `${i === index ? ">" : " "} ${clean(d.name).slice(0, 27).padEnd(28)} ${d.platform.padEnd(8)} ${d.kind.padEnd(8)} ${(d.online ? "online" : "offline").padEnd(8)} ${clean(d.locked ? "LOCKED" : s ? `${s.owner}: ${s.reason}` : "free")}`.slice(
          0,
          width,
        );
      })
      .join("\n");
    ui.draw(
      `DEVICE DECK / TERMINAL\n${rows.length} configured devices · filter ${filter || "all"}\n\n  DEVICE                       PLATFORM TYPE     HEALTH   RESERVATION\n${table || "No configured devices. Use d to discover, or edit configuration in the dashboard."}\n\n↑ ↓ Select   Enter Reserve & remote   / Filter   a Clear filter\nl Lock   u Unlock   d Discover   h History   c Captures\nw Web dashboard   q Quit\n\n${clean(message)}\n`,
    );
    const key = await ui.key();
    if (key.name === "q" || (key.ctrl && key.name === "c")) break;
    if (key.name === "up") index--;
    else if (key.name === "down") index++;
    else if (key.name === "a") {
      filter = "";
      index = 0;
    } else if (key.name === "/" || key.sequence === "/") {
      filter = await ui.ask("\nName filter: ");
      index = 0;
    } else
      try {
        const d = rows[index];
        if (key.name === "return" && d) {
          const owner = await ui.ask("\nOwner label: ");
          const reason = await ui.ask("Reservation reason: ");
          const acquired = await callOperation("sessions.reserve", {
            selector: { device: d.id },
            owner: owner || snapshot.config.settings.owner,
            reason,
          });
          ui.close();
          await interactiveRemote(d, acquired);
          ui = terminal();
          message = "Session released.";
        } else if ((key.name === "l" || key.name === "u") && d) {
          const reason = await ui.ask("\nMaintenance reason: ");
          message = JSON.stringify(
            await callOperation("devices.bulk", {
              ids: [d.id],
              action: key.name === "l" ? "lock" : "unlock",
              reason,
            }),
          );
        } else if (key.name === "d") {
          const found = await callOperation("discover");
          message = `Found ${found.devices.length} devices and ${found.sources.length} capture sources. Use the web dashboard to register them.`;
        } else if (key.name === "w") {
          spawn("/usr/bin/open", [await browserUrl()], { stdio: "ignore" });
          message = "Opened web dashboard.";
        } else if (key.name === "h" || key.name === "c") {
          const text =
            key.name === "h"
              ? snapshot.events
                  .slice(0, 20)
                  .map(
                    (e) =>
                      `${new Date(e.at).toLocaleString()} ${e.owner} ${e.action} ${e.detail}`,
                  )
                  .join("\n")
              : snapshot.artifacts
                  .slice(0, 20)
                  .map((a) => `${a.status} ${a.name} ${a.path}`)
                  .join("\n");
          ui.draw(
            text.split("\n").map(clean).join("\n") +
              "\n\nPress any key to return.",
          );
          await ui.key();
        }
      } catch (e) {
        message = (e as Error).message;
      }
  }
} finally {
  ui.close();
}
