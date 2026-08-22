import type { BridgeDatabase } from "./database.js";
import type { TerminalWriteInput } from "./types.js";

export class TerminalWriter {
  readonly #database: Pick<BridgeDatabase, "writeTerminal">;
  readonly #written = new Set<string>();
  readonly #inFlight = new Map<string, Promise<boolean>>();

  constructor(database: Pick<BridgeDatabase, "writeTerminal">) {
    this.#database = database;
  }

  async write(input: TerminalWriteInput): Promise<boolean> {
    if (this.#written.has(input.runId)) return false;
    const existing = this.#inFlight.get(input.runId);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const applied = await this.#database.writeTerminal(input);
        if (applied) this.#written.add(input.runId);
        return applied;
      } finally {
        this.#inFlight.delete(input.runId);
      }
    })();
    this.#inFlight.set(input.runId, pending);
    return pending;
  }
}
