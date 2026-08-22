import { describe, expect, it, vi } from "vitest";
import {
  MemoryIngressQueue,
  TaskNotificationCoordinator,
  type IngressQueueLike,
  type IngressQueueRecord,
} from "../src/notification-coordinator.js";

interface Payload { taskId: string }

class FakeQueue implements IngressQueueLike<Payload> {
  pending = new Map<string, Payload>();
  claims = new Map<string, Payload>();
  completed = new Set<string>();

  async enqueue(id: string, payload: Payload): Promise<{ kind: string; duplicate: boolean }> {
    if (this.pending.has(id) || this.claims.has(id) || this.completed.has(id)) return { kind: "completed", duplicate: true };
    this.pending.set(id, payload);
    return { kind: "accepted", duplicate: false };
  }

  async claimNext(): Promise<IngressQueueRecord<Payload> | null> {
    const next = this.pending.entries().next();
    if (next.done) return null;
    const [id, payload] = next.value;
    this.pending.delete(id);
    this.claims.set(id, payload);
    return { id, payload, claim: { token: `claim-${id}` } };
  }

  async complete(claim: IngressQueueRecord<Payload>): Promise<boolean> {
    this.claims.delete(claim.id);
    this.completed.add(claim.id);
    return true;
  }

  async release(claim: IngressQueueRecord<Payload>): Promise<boolean> {
    this.claims.delete(claim.id);
    this.pending.set(claim.id, claim.payload);
    return true;
  }

  async recoverStaleClaims(): Promise<number> {
    return 0;
  }
}

describe("Realtime notification coordination", () => {
  it("provides an external-plugin-safe queue with duplicate and stale-claim handling", async () => {
    const queue = new MemoryIngressQueue<Payload>();
    expect(await queue.enqueue("task-1", { taskId: "task-1" })).toMatchObject({ duplicate: false });
    expect(await queue.enqueue("task-1", { taskId: "task-1" })).toMatchObject({ duplicate: true });
    const claim = await queue.claimNext({ staleMs: 0 });
    expect(claim?.id).toBe("task-1");
    expect(await queue.recoverStaleClaims({ staleMs: 0 })).toBe(1);
    const recovered = await queue.claimNext();
    expect(recovered?.id).toBe("task-1");
    expect(await queue.complete(recovered!)).toBe(true);
    expect(await queue.enqueue("task-1", { taskId: "task-1" })).toMatchObject({ duplicate: true });
  });

  it("does not execute a duplicate notification twice", async () => {
    const queue = new FakeQueue();
    const process = vi.fn(async () => undefined);
    const coordinator = new TaskNotificationCoordinator({ queue, ownerId: "worker", process });
    await coordinator.start();
    await coordinator.notify({ taskId: "task-1" });
    await coordinator.notify({ taskId: "task-1" });
    await coordinator.drain();
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("reconciliation enqueues durable pending tasks after reconnect", async () => {
    const queue = new FakeQueue();
    const process = vi.fn(async () => undefined);
    const coordinator = new TaskNotificationCoordinator({ queue, ownerId: "worker", process });
    await coordinator.start();
    await coordinator.reconcile([{ taskId: "missed-while-disconnected" }]);
    expect(process).toHaveBeenCalledWith({ taskId: "missed-while-disconnected" });
  });
});
