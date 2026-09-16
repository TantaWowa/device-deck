import { controlMessageSchema, type ControlMessage, type InteractiveSource, type PointerInput } from "../../../packages/core/src/live";

/** One bounded, ordered input queue per controller; movement can never queue behind old movement indefinitely. */
export class ControlStream {
  private queue: ControlMessage[] = [];
  private contacts = new Map<number, PointerInput>();
  private running?: Promise<void>;
  private generation = 0;
  private closed = false;
  private failure?: Error;
  private suspended = 0;
  constructor(
    private source: InteractiveSource,
    private validate: () => Promise<void>,
    private onError: (error: Error) => void,
  ) {}
  send(value: unknown) {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("This control stream closed. Start a new control session.");
    const message = controlMessageSchema.parse(value);
    // Hardware input owns the device until it completes. Never retain touch
    // messages received during that interval for later replay.
    if (this.suspended) return;
    if (message.type === "cancel") { void this.cancel(); return; }
    if (message.type === "pointer" && message.event.type === "move") {
      // Coalesce only within the current run of movement; never cross a down/up barrier.
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const pending = this.queue[i];
        if (pending.type !== "pointer" || pending.event.type !== "move") break;
        if (pending.event.contactId === message.event.contactId) { this.queue[i] = message; return; }
      }
    }
    if (this.queue.length >= 64) {
      void this.cancel();
      throw new Error("Touch input arrived too quickly. Contacts were cancelled; start the gesture again.");
    }
    this.queue.push(message);
    this.drain();
  }
  private drain() {
    if (this.running || this.closed || this.suspended) return;
    const generation = this.generation;
    this.running = (async () => {
      while (!this.closed && !this.suspended && generation === this.generation && this.queue.length) {
        const message = this.queue.shift()!;
        await this.validate();
        if (this.closed || generation !== this.generation) break;
        if (message.type === "gesture") {
          if (!this.source.capabilities.includes(message.gesture.type)) throw new Error("This device does not support that gesture.");
          if (this.contacts.size) throw new Error("Finish the current touch before sending a gesture.");
          await this.source.gesture(message.gesture);
        } else if (message.type === "pointer") {
          const p = message.event;
          if (!this.source.capabilities.includes("drag")) throw new Error("This device supports completed gestures, not continuous pointer input.");
          if (p.type === "down") {
            if (this.contacts.has(p.contactId)) throw new Error("This contact is already down.");
            if (this.contacts.size >= (this.source.capabilities.includes("multitouch") ? 10 : 1)) throw new Error("Too many simultaneous contacts.");
            this.contacts.set(p.contactId, p);
          } else {
            if (!this.contacts.has(p.contactId)) continue;
            if (p.type === "move") this.contacts.set(p.contactId, p);
          }
          await this.source.pointer(p);
          if (p.type === "up" || p.type === "cancel") this.contacts.delete(p.contactId);
        }
      }
    })().catch(async (error) => {
      if (generation !== this.generation || this.closed) return;
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.queue = [];
      this.generation++;
      await this.cancelContacts();
      this.onError(this.failure);
    }).finally(() => {
      this.running = undefined;
      if (this.queue.length) this.drain();
    });
  }
  private async cancelContacts() {
    const contacts = [...this.contacts.values()];
    this.contacts.clear();
    for (const p of contacts) await this.source.pointer({ ...p, type: "cancel" }).catch(() => {});
    // Discrete idb gestures use the same cancel signal, even with no streamed contacts.
    if (!contacts.length) await this.source.pointer({ type: "cancel", contactId: 0, x: 0, y: 0, width: 1, height: 1 }).catch(() => {});
  }
  async cancel() {
    this.generation++;
    this.queue = [];
    await this.cancelContacts();
    await this.running;
  }
  async close() { this.closed = true; await this.cancel(); }
  async settled() { while (this.running) await this.running; if (this.failure) throw this.failure; }
  /** Cancel held/queued touches and finish any already-running bounded HID
   * sequence before a hardware key, keeping this controller alive afterwards. */
  async suspend(): Promise<() => void> {
    if (this.closed || this.failure) throw this.failure || new Error("The control stream closed.");
    this.suspended++;
    try { await this.cancel(); }
    catch (error) { this.suspended--; throw error; }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.suspended--;
    };
  }
}
