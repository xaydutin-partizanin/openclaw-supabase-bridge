import type { BridgeDatabase } from "./database.js";
import type { BridgeEvent } from "./types.js";

export class EventBuffer {
  readonly #database: BridgeDatabase;
  readonly #onError: (error: unknown) => void;
  readonly #batchSize: number;
  readonly #flushDelayMs: number;
  #pending: BridgeEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushing: Promise<void> | null = null;
  #stopped = false;

  constructor(
    database: BridgeDatabase,
    options: { batchSize?: number; flushDelayMs?: number; onError?: (error: unknown) => void } = {},
  ) {
    this.#database = database;
    this.#batchSize = options.batchSize ?? 25;
    this.#flushDelayMs = options.flushDelayMs ?? 250;
    this.#onError = options.onError ?? (() => undefined);
  }

  append(event: BridgeEvent): void {
    if (this.#stopped) return;
    this.#pending.push(event);
    if (this.#pending.length >= this.#batchSize) {
      void this.flush();
      return;
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.flush();
      }, this.#flushDelayMs);
    }
  }

  async flush(): Promise<void> {
    if (this.#flushing) {
      await this.#flushing;
      if (this.#pending.length) await this.flush();
      return;
    }
    if (!this.#pending.length) return;
    const batch = this.#pending.splice(0, this.#batchSize);
    this.#flushing = (async () => {
      try {
        await this.#database.appendEvents(batch);
      } catch (error) {
        this.#pending.unshift(...batch);
        this.#onError(error);
      } finally {
        this.#flushing = null;
      }
    })();
    await this.#flushing;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    while (this.#pending.length) {
      const before = this.#pending.length;
      await this.flush();
      if (this.#pending.length >= before) break;
    }
  }
}
