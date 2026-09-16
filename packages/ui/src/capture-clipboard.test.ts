import assert from "node:assert/strict";
import test from "node:test";
import { copyImageToClipboard } from "./capture-clipboard";

test("clipboard write happens before async image capture, preserving click activation", async (t) => {
  const order: string[] = [];
  const original = new Map(["isSecureContext", "navigator", "ClipboardItem"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  class Item {
    constructor(public data: Record<string, Promise<Blob>>) { order.push("item"); }
  }
  Object.defineProperties(globalThis, {
    isSecureContext: { configurable: true, value: true },
    ClipboardItem: { configurable: true, value: Item },
    navigator: { configurable: true, value: { clipboard: { write: async (items: Item[]) => {
      order.push("write");
      assert.equal((await items[0].data["image/png"]).type, "image/png");
    } } } },
  });
  await copyImageToClipboard(async () => { order.push("capture"); return new Blob(["png"], { type: "image/png" }); });
  assert.deepEqual(order, ["item", "write", "capture"]);
  await assert.rejects(copyImageToClipboard(async () => { throw new Error("Device disconnected"); }), /Device disconnected/);
  await assert.rejects(copyImageToClipboard(async () => new Blob(["jpeg"], { type: "image/jpeg" })), /not a PNG/);
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: false });
  await assert.rejects(copyImageToClipboard(async () => { throw new Error("Must not start capture"); }), /HTTPS/);
});
