import { stripVTControlCharacters } from "node:util";
export const clean = (value: unknown) =>
  stripVTControlCharacters(String(value ?? "")).replace(
    /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    " ",
  );
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function glyphs(value: string) {
  return [...segmenter.segment(clean(value))].map((s) => s.segment);
}
export function glyphWidth(value: string) {
  const c = value.codePointAt(0) || 0;
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(value)) return 0;
  return /\p{Extended_Pictographic}/u.test(value) ||
    (c >= 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe10 && c <= 0xfe6f) ||
        (c >= 0xff01 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) ||
        (c >= 0x20000 && c <= 0x3fffd)))
    ? 2
    : 1;
}
export const cellWidth = (text: string) =>
  glyphs(text).reduce((n, g) => n + glyphWidth(g), 0);
export function fit(value: unknown, width: number) {
  let result = "",
    used = 0;
  for (const g of glyphs(clean(value))) {
    const n = glyphWidth(g);
    if (used + n > width) break;
    result += g;
    used += n;
  }
  return result + " ".repeat(Math.max(0, width - used));
}
export function wrap(value: unknown, width: number): string[] {
  width = Math.max(1, Math.floor(width));
  const words = clean(value).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (let word of words) {
    if (line && cellWidth(line + " " + word) > width) {
      lines.push(line);
      line = "";
    }
    while (cellWidth(word) > width) {
      const part = fit(word, width).trimEnd();
      if (!part) {
        lines.push("?");
        word = word.slice(glyphs(word)[0].length);
      } else {
        lines.push(part);
        word = word.slice(part.length);
      }
    }
    line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}
export type Style =
  | "normal"
  | "dim"
  | "title"
  | "accent"
  | "selected"
  | "good"
  | "warn"
  | "bad"
  | "menu";
const styles: Record<Style, string> = {
  normal: "0",
  dim: "2",
  title: "1;36",
  accent: "36",
  selected: "1;30;46",
  good: "32",
  warn: "33",
  bad: "31",
  menu: "1;37;44",
};
export class Screen {
  private cells: { value: string; style: Style }[][];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ({
        value: " ",
        style: "normal" as Style,
      })),
    );
  }
  text(
    x: number,
    y: number,
    value: unknown,
    width = this.width - x,
    style: Style = "normal",
  ) {
    if (y < 0 || y >= this.height) return;
    let offset = 0;
    for (const g of glyphs(fit(value, Math.max(0, width)))) {
      const n = glyphWidth(g);
      if (!n) continue;
      if (x + offset >= 0 && x + offset + n <= this.width) {
        for (let j = 0; j < n; j++) {
          const column = x + offset + j,
            old = this.cells[y][column];
          if (old.value === "" && column > 0)
            this.cells[y][column - 1] = { value: " ", style };
          if (glyphWidth(old.value) > 1 && column + 1 < this.width)
            this.cells[y][column + 1] = { value: " ", style };
        }
        this.cells[y][x + offset] = { value: g, style };
        for (let j = 1; j < n; j++)
          this.cells[y][x + offset + j] = { value: "", style };
      }
      offset += n;
    }
  }
  box(
    x: number,
    y: number,
    width: number,
    height: number,
    title = "",
    style: Style = "dim",
  ) {
    if (width < 2 || height < 2) return;
    for (let row = y; row < y + height; row++) this.text(x, row, "", width);
    this.text(x, y, "┌" + "─".repeat(width - 2) + "┐", width, style);
    this.text(
      x,
      y + height - 1,
      "└" + "─".repeat(width - 2) + "┘",
      width,
      style,
    );
    for (let row = y + 1; row < y + height - 1; row++) {
      this.text(x, row, "│", 1, style);
      this.text(x + width - 1, row, "│", 1, style);
    }
    if (title)
      this.text(
        x + 2,
        y,
        ` ${title} `,
        Math.min(width - 4, cellWidth(title) + 2),
        "title",
      );
  }
  lines(color = true) {
    return this.cells.map((row) => {
      let style: Style | undefined,
        result = "";
      for (const cell of row) {
        if (color && style !== cell.style) {
          result += `\x1b[${styles[cell.style]}m`;
          style = cell.style;
        }
        result += cell.value;
      }
      return result + (color ? "\x1b[0m" : "");
    });
  }
}
export function visibleWindow<T>(items: T[], selected: number, limit: number) {
  const size = Math.max(1, Math.floor(limit)),
    index = Math.max(0, Math.min(selected, items.length - 1));
  const start = Math.max(
    0,
    Math.min(items.length - size, index - Math.floor(size / 2)),
  );
  return {
    start,
    end: Math.min(items.length, start + size),
    rows: items.slice(start, start + size),
  };
}
