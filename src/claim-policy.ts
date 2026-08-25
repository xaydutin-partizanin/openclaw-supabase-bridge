import type { BridgeTask } from "./types.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

export function isTaskClaimable(task: BridgeTask, now: Date): boolean {
  if (TERMINAL.has(task.status)) return false;
  if (task.status === "staged") return false;
  if (task.status === "pending") return true;
  if (task.status !== "claimed") return false;
  if (!task.leaseExpiresAt) return true;
  return Date.parse(task.leaseExpiresAt) <= now.getTime();
}

export function claimTaskInMemory(
  task: BridgeTask,
  workerId: string,
  now: Date,
  leaseSeconds: number,
): BridgeTask | null {
  if (!isTaskClaimable(task, now)) return null;
  return {
    ...task,
    status: "claimed",
    claimedBy: workerId,
    claimedAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(),
    updatedAt: now.toISOString(),
  };
}
