import { Screen, fit, cellWidth, visibleWindow, wrap } from "./screen";
import { menus, Workspace } from "./workspace";

export function render(
  workspace: Workspace,
  width: number,
  height: number,
  color = true,
) {
  const screen = new Screen(width, height);
  if (width < 70 || height < 20) {
    screen.text(1, 1, "DEVICE DECK", Math.max(0, width - 2), "title");
    const message = `Enlarge terminal to at least 71 columns × 21 rows. Current: ${width + 1} × ${height + 1}. Q quits.`;
    wrap(message, Math.max(2, width - 2)).forEach((line, i) =>
      screen.text(1, 3 + i, line, Math.max(0, width - 2)),
    );
    if (workspace.dialog) drawDialog(screen, workspace);
    return screen.lines(color);
  }
  const snapshot = workspace.snapshot;
  screen.text(1, 0, "DEVICE DECK", 16, "title");
  screen.text(17, 0, "LOCAL WORKSPACE", width - 40, "dim");
  screen.text(
    width - 23,
    0,
    snapshot
      ? `${snapshot.license.tier} · ${snapshot.devices.length} devices`
      : "Connecting…",
    22,
    "accent",
  );
  const bodyY = 2,
    bodyH = height - 8,
    sideW = 17,
    mainX = 18,
    mainW = width - mainX;
  screen.box(
    0,
    bodyY,
    sideW,
    bodyH,
    "Workspace",
    workspace.focus === "menu" && !workspace.remote ? "accent" : "dim",
  );
  menus.forEach((view, i) => {
    const active = workspace.view === view;
    screen.text(
      1,
      bodyY + 2 + i,
      ` ${i + 1} ${view}`,
      sideW - 2,
      active ? (workspace.focus === "menu" ? "selected" : "menu") : "normal",
    );
  });
  if (bodyH > 14) {
    screen.text(
      2,
      bodyY + bodyH - 3,
      `${snapshot?.sessions.filter((s) => s.state !== "closed").length || 0} reserved`,
      sideW - 4,
      "dim",
    );
    screen.text(
      2,
      bodyY + bodyH - 2,
      `${snapshot?.recordings.length || 0} recording`,
      sideW - 4,
      snapshot?.recordings.length ? "warn" : "dim",
    );
  }
  const title = workspace.discovery
    ? "Discover devices"
    : workspace.remote
      ? "Remote"
      : workspace.view;
  screen.box(
    mainX,
    bodyY,
    mainW,
    bodyH,
    title,
    workspace.focus === "items" ? "accent" : "dim",
  );
  screen.text(mainX + 2, bodyY + 1, workspace.subtitle(), mainW - 4, "dim");
  if (workspace.remote)
    drawRemote(screen, workspace, mainX + 2, bodyY + 3, mainW - 4, bodyH - 5);
  else {
    const rows = workspace.rows(),
      wide = mainW >= 94;
    const listWidth = wide ? Math.floor((mainW - 5) * 0.58) : mainW - 4;
    const detailX = mainX + 3 + listWidth;
    const detailH = wide ? bodyH - 4 : Math.min(5, Math.floor((bodyH - 4) / 3));
    const listH = wide ? bodyH - 6 : bodyH - detailH - 6;
    workspace.pageSize = Math.max(1, listH);
    const window = visibleWindow(rows, workspace.index, listH);
    screen.text(
      mainX + 2,
      bodyY + 3,
      `ITEM${" ".repeat(Math.max(1, listWidth - 23))}STATUS`,
      listWidth,
      "dim",
    );
    window.rows.forEach((row, i) => {
      const selected = window.start + i === workspace.index;
      const metaWidth = Math.min(27, Math.floor(listWidth * 0.45)),
        labelWidth = listWidth - metaWidth - 4;
      screen.text(
        mainX + 2,
        bodyY + 4 + i,
        `${selected ? "›" : " "} ${fit(row.label, labelWidth)}  ${fit(row.meta, metaWidth)}`,
        listWidth,
        selected ? "selected" : row.tone || "normal",
      );
    });
    if (!rows.length)
      screen.text(
        mainX + 2,
        bodyY + 4,
        snapshot
          ? workspace.discovery
            ? "No devices discovered."
            : workspace.view === "Devices"
              ? "No matches. X clears filters; D discovers devices."
              : "No items in this view."
          : "Waiting for the local daemon…",
        listWidth,
        "dim",
      );
    screen.text(
      mainX + 2,
      bodyY + 4 + Math.max(1, listH),
      rows.length
        ? `${window.start + 1}–${window.end} of ${rows.length} · ↑ ↓ select`
        : "0 items",
      listWidth,
      "dim",
    );
    const selected = workspace.selected;
    if (wide) {
      screen.box(detailX, bodyY + 3, width - detailX - 1, bodyH - 4, "Details");
      drawDetails(
        screen,
        selected?.detail || ["Select an item."],
        detailX + 2,
        bodyY + 4,
        width - detailX - 5,
        detailH - 2,
      );
    } else {
      const y = bodyY + bodyH - detailH - 1;
      screen.text(mainX + 2, y, "─".repeat(mainW - 4), mainW - 4, "dim");
      drawDetails(
        screen,
        selected?.detail || [],
        mainX + 2,
        y + 1,
        mainW - 4,
        detailH - 1,
      );
    }
  }
  const y = height - 5;
  workspace
    .hints()
    .forEach((line, i) =>
      screen.text(1, y + i, line, width - 2, i ? "dim" : "accent"),
    );
  const status = workspace.busy ? `◌ ${workspace.busy}…` : workspace.status;
  screen.text(
    1,
    height - 2,
    status,
    width - 2,
    workspace.error && !workspace.busy
      ? "bad"
      : workspace.busy
        ? "warn"
        : "normal",
  );
  screen.text(
    1,
    height - 1,
    workspace.remote
      ? "Esc Return   M Actions   U Renew   E End session   Q Return / quit"
      : "1–8 Views   Tab Menu / items   ↑ ↓ Move   Enter Actions   ? Help   Q Quit",
    width - 2,
    "dim",
  );
  if (workspace.dialog) drawDialog(screen, workspace);
  return screen.lines(color);
}
function drawDetails(
  screen: Screen,
  lines: string[],
  x: number,
  y: number,
  width: number,
  height: number,
) {
  lines
    .flatMap((line) => wrap(line, width))
    .slice(0, height)
    .forEach((line, i) =>
      screen.text(x, y + i, line, width, i === 0 ? "title" : "normal"),
    );
}
function drawRemote(
  screen: Screen,
  workspace: Workspace,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const device = workspace.remote!,
    session = workspace.session(device.id);
  const art = [
    "          [ ↑ ]",
    "    [ ← ] [OK ] [ → ]",
    "          [ ↓ ]",
    "",
    "[B] BACK   [H] HOME   [*] SPECIAL",
    "[[] REWIND [Space] PLAY []] FFWD",
    "[P] REPLAY [T] TEXT   [S] SHOT",
  ];
  art
    .slice(0, Math.max(0, height - 4))
    .forEach((line, i) =>
      screen.text(
        x + Math.max(0, Math.floor((width - 34) / 2)),
        y + i,
        line,
        Math.min(width, 36),
        "accent",
      ),
    );
  screen.text(
    x,
    y + height - 3,
    session
      ? `${session.owner}: ${session.reason}`
      : "No active session. An action will offer to reserve.",
    width,
    "dim",
  );
  screen.text(
    x,
    y + height - 2,
    session
      ? `Expires ${new Date(session.expiresAt).toLocaleTimeString()}`
      : "",
    width,
    "dim",
  );
  screen.text(
    x,
    y + height - 1,
    workspace.recording(device.id)
      ? "● RECORDING · V stops and saves"
      : "○ Not recording · V starts",
    width,
    workspace.recording(device.id) ? "warn" : "dim",
  );
}
function drawDialog(screen: Screen, workspace: Workspace) {
  const dialog = workspace.dialog!;
  const width = Math.min(76, screen.width - 4),
    inner = Math.max(2, width - 4);
  if (width < 10 || screen.height < 8) return;
  const description =
    dialog.kind === "info" ? [] : wrap(dialog.description, inner);
  const items =
    dialog.kind === "menu"
      ? dialog.actions.length
      : dialog.kind === "form"
        ? dialog.fields.length * 3
        : dialog.lines.flatMap((line) => wrap(line, inner)).length;
  const height = Math.min(
    screen.height - 4,
    Math.max(8, items + description.length + 5),
  );
  const x = Math.floor((screen.width - width) / 2),
    y = Math.floor((screen.height - height) / 2);
  screen.box(x, y, width, height, dialog.title, "accent");
  const desc = description.slice(0, Math.max(0, height - 7));
  desc.forEach((line, i) => screen.text(x + 2, y + 1 + i, line, inner, "dim"));
  const startY = y + 2 + desc.length,
    limit = Math.max(1, height - desc.length - 5);
  if (dialog.kind === "menu") {
    const window = visibleWindow(dialog.actions, dialog.index, limit);
    window.rows.forEach((a, i) =>
      screen.text(
        x + 2,
        startY + i,
        `${window.start + i === dialog.index ? "›" : " "} ${a.key === "return" ? "↵" : a.key.toUpperCase()}  ${a.label}${a.disabled ? " (unavailable)" : ""}`,
        inner,
        a.disabled
          ? "dim"
          : window.start + i === dialog.index
            ? "selected"
            : "normal",
      ),
    );
    screen.text(
      x + 2,
      y + height - 2,
      "↑ ↓ Select   Enter Choose   Esc Cancel",
      inner,
      "dim",
    );
  } else if (dialog.kind === "form") {
    const window = visibleWindow(
      dialog.fields,
      dialog.index,
      Math.max(1, Math.floor(limit / 3)),
    );
    window.rows.forEach((field, i) => {
      const active = window.start + i === dialog.index;
      screen.text(
        x + 2,
        startY + i * 3,
        field.label + (field.required ? " *" : ""),
        inner,
        "dim",
      );
      // Show the end of long text while editing, without exposing terminal controls.
      let value = field.value;
      while (cellWidth(value) > inner - 3)
        value = value.slice([...value][0]?.length || 1);
      screen.text(
        x + 2,
        startY + i * 3 + 1,
        ` ${value}${active ? "▏" : ""}`,
        inner,
        active ? "selected" : "normal",
      );
    });
    screen.text(
      x + 2,
      y + height - 2,
      "Tab Next field   Enter Continue / save   Ctrl+U Clear   Esc Cancel",
      inner,
      "dim",
    );
  } else {
    const lines = dialog.lines.flatMap((line) => wrap(line, inner));
    // Info scrolling counts wrapped lines, so long details remain reachable.
    dialog.index = Math.max(0, Math.min(dialog.index, lines.length - 1));
    lines
      .slice(dialog.index, dialog.index + limit)
      .forEach((line, i) => screen.text(x + 2, startY + i, line, inner));
    screen.text(
      x + 2,
      y + height - 2,
      "↑ ↓ Scroll   Enter / Esc Close",
      inner,
      "dim",
    );
  }
}
