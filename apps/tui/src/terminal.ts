import { emitKeypressEvents, createInterface } from "node:readline";
export type Key = { name?: string; sequence?: string; ctrl?: boolean };
export function terminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The TUI requires an interactive terminal. Use devdeck devices --json for scripts.",
    );
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return {
    draw: (value: string) => process.stdout.write("\x1b[2J\x1b[H" + value),
    key: () =>
      new Promise<Key>((resolve) => {
        process.stdin.once("keypress", (_str, key: Key) => resolve(key));
      }),
    ask: (prompt: string) =>
      new Promise<string>((resolve) => {
        process.stdin.setRawMode(false);
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(prompt, (answer) => {
          rl.close();
          process.stdin.setRawMode(true);
          process.stdin.resume();
          resolve(answer);
        });
      }),
    close: () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[0m\n");
    },
  };
}
export const clean = (value: string) =>
  value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\x1b/g, "");
