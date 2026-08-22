import { randomUUID } from "node:crypto";
import { errorMessage } from "./object-utils.js";

export interface IngressQueueRecord<T> {
  id: string;
  payload: T;
  claim: { token: string };
}

export interface IngressQueueLike<T> {
  enqueue(id: string, payload: T): Promise<{ kind: string; duplicate: boolean }>;
  claimNext(options?: { ownerId?: string; staleMs?: number }): Promise<IngressQueueRecord<T> | null>;
  complete(claim: IngressQueueRecord<T>): Promise<boolean>;
  release(claim: IngressQueueRecord<T>, options?: { lastError?: string }): Promise<boolean>;
  recoverStaleClaims(options?: { staleMs?: number }): Promise<number>;
}

interface MemoryClaim<T> {
  payload: T;
  token: string;
  claimedAt: number;
}

/**
 * Notification-level fallback for external plugins that cannot use OpenClaw's
 * trusted-only keyed store. Supabase claims and leases remain the durable
 * execution authority; this queue only coalesces Realtime/reconciliation work
 * inside the current Gateway process.
 */
export class MemoryIngressQueue<T> implements IngressQueueLike<T> {
  readonly #pending = new Map<string, T>();
  readonly #claimed = new Map<string, MemoryClaim<T>>();
  readonly #completed = new Set<string>();

  async enqueue(id: string, payload: T): Promise<{ kind: string; duplicate: boolean }> {
    if (this.#pending.has(id) || this.#claimed.has(id) || this.#completed.has(id)) {
      return { kind: "duplicate", duplicate: true };
    }
    this.#pending.set(id, payload);
    return { kind: "accepted", duplicate: false };
  }

  async claimNext(options?: { ownerId?: string; staleMs?: number }): Promise<IngressQueueRecord<T> | null> {
    await this.recoverStaleClaims(
      options?.staleMs === undefined ? undefined : { staleMs: options.staleMs },
    );
    const next = this.#pending.entries().next();
    if (next.done) return null;
    const [id, payload] = next.value;
    const token = randomUUID();
    this.#pending.delete(id);
    this.#claimed.set(id, { payload, token, claimedAt: Date.now() });
    return { id, payload, claim: { token } };
  }

  async complete(claim: IngressQueueRecord<T>): Promise<boolean> {
    const current = this.#claimed.get(claim.id);
    if (!current || current.token !== claim.claim.token) return false;
    this.#claimed.delete(claim.id);
    this.#completed.add(claim.id);
    return true;
  }

  async release(claim: IngressQueueRecord<T>): Promise<boolean> {
    const current = this.#claimed.get(claim.id);
    if (!current || current.token !== claim.claim.token) return false;
    this.#claimed.delete(claim.id);
    this.#pending.set(claim.id, current.payload);
    return true;
  }

  async recoverStaleClaims(options?: { staleMs?: number }): Promise<number> {
    const staleMs = options?.staleMs ?? 60_000;
    const cutoff = Date.now() - staleMs;
    let recovered = 0;
    for (const [id, claim] of this.#claimed) {
      if (claim.claimedAt > cutoff) continue;
      this.#claimed.delete(id);
      this.#pending.set(id, claim.payload);
      recovered += 1;
    }
    return recovered;
  }
}

export class TaskNotificationCoordinator<T extends { taskId: string }> {
  readonly #queue: IngressQueueLike<T>;
  readonly #ownerId: string;
  readonly #process: (payload: T) => Promise<void>;
  #draining: Promise<void> | null = null;
  #stopped = false;

  constructor(input: {
    queue: IngressQueueLike<T>;
    ownerId: string;
    process: (payload: T) => Promise<void>;
  }) {
    this.#queue = input.queue;
    this.#ownerId = input.ownerId;
    this.#process = input.process;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#queue.recoverStaleClaims({ staleMs: 60_000 });
  }

  async notify(payload: T): Promise<boolean> {
    const result = await this.#queue.enqueue(payload.taskId, payload);
    if (!this.#stopped) void this.drain();
    return !result.duplicate;
  }

  async reconcile(payloads: T[]): Promise<void> {
    for (const payload of payloads) await this.notify(payload);
    await this.drain();
  }

  async drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    this.#draining = (async () => {
      while (!this.#stopped) {
        const claim = await this.#queue.claimNext({ ownerId: this.#ownerId, staleMs: 60_000 });
        if (!claim) break;
        try {
          await this.#process(claim.payload);
          await this.#queue.complete(claim);
        } catch (error) {
          await this.#queue.release(claim, { lastError: errorMessage(error) });
          break;
        }
      }
    })();
    try {
      await this.#draining;
    } finally {
      this.#draining = null;
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#draining) await this.#draining;
  }
}
