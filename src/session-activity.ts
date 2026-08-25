import { asRecord, asString } from "./object-utils.js";

const TERMINAL_SESSION_STATUSES = new Set([
  "done",
  "failed",
  "complete",
  "completed",
  "cancelled",
  "canceled",
  "timed_out",
  "idle",
  "archived",
]);

/**
 * Whether a live OpenClaw session entry currently holds an active write-capable run.
 * `restartRecoveryDeliveryRunId` alone is not enough once status is terminal — that
 * marker can linger after the session is done and falsely block checkout exclusivity.
 */
export function sessionEntryHasActiveRun(entry: unknown): boolean {
  const row = asRecord(entry);
  const status = (asString(row.status) ?? "").toLowerCase();
  if (status === "running") return true;
  if (!asString(row.restartRecoveryDeliveryRunId)) return false;
  if (status && TERMINAL_SESSION_STATUSES.has(status)) return false;
  return true;
}
