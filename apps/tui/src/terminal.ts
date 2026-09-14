import { emitKeypressEvents } from "node:readline";
export { clean } from "./screen";
export type Key = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
};
export function terminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The TUI requires an interactive terminal. Use devdeck devices --json for scripts.",
    );
  const raw = process.stdin.isRaw;
  let closed = false,
    pending: ((key: Key) => void) | undefined,
    lastSize = "";
  const queue: Key[] = [];
  const deliver = (key: Key) => {
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(key);
    } else if (queue.length < 64) queue.push(key);
  };
  const keypress = (_text: string, key: Key) => deliver(key);
  const resize = () => deliver({ name: "resize" });
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", keypress);
  process.stdout.on("resize", resize);
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  const close = () => {
    if (closed) return;
    closed = true;
    process.stdin.off("keypress", keypress);
    process.stdout.off("resize", resize);
    process.stdin.setRawMode(Boolean(raw));
    process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    process.off("exit", close);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", terminate);
  };
  const terminate = () => {
    close();
    process.exit(0);
  };
  process.once("exit", close);
  process.once("SIGTERM", terminate);
  process.once("SIGHUP", terminate);
  return {
    size: () => ({
      width: Math.max(1, (process.stdout.columns || 100) - 1),
      height: Math.max(1, (process.stdout.rows || 30) - 1),
    }),
    draw: (lines: string[]) => {
      const size = `${process.stdout.columns}:${process.stdout.rows}`;
      if (!closed)
        process.stdout.write(
          (size !== lastSize ? "\x1b[2J" : "") +
            "\x1b[H" +
            lines.join("\r\n") +
            "\x1b[0m",
        );
      lastSize = size;
    },
    key: (timeout = 250) =>
      new Promise<Key>((resolve) => {
        const next = queue.shift();
        if (next) {
          resolve(next);
          return;
        }
        const timer = setTimeout(() => {
          pending = undefined;
          resolve({ name: "tick" });
        }, timeout);
        pending = (key) => {
          clearTimeout(timer);
          resolve(key);
        };
      }),
    close,
  };
}
