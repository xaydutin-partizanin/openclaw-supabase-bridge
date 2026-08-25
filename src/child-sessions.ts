import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { asRecord, asString } from "./object-utils.js";
import { sessionEntryHasActiveRun } from "./session-activity.js";
import { listAllSessionEntries } from "./telemetry/public-runtime.js";

export interface ChildSessionSnapshot {
  sessionKey: string;
  sessionId: string;
  status: string | null;
  hasActiveRun: boolean;
  parentSessionKey: string | null;
}

const FAILED_CHILD_STATUSES = new Set([
  "failed",
  "cancelled",
  "canceled",
  "timed_out",
  "error",
]);

function parentOf(entry: Record<string, unknown>): string | null {
  return asString(entry.parentSessionKey) ?? asString(entry.spawnedBy);
}

/** Live OpenClaw sessions whose parent/spawnedBy matches `parentSessionKey`. */
export function listChildSessions(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
  parentSessionKey: string,
): ChildSessionSnapshot[] {
  const children: ChildSessionSnapshot[] = [];
  for (const summary of listAllSessionEntries(api, cfg)) {
    const row = asRecord(summary);
    const entry = asRecord(row.entry);
    const sessionKey = asString(row.sessionKey);
    const sessionId = asString(entry.sessionId);
    if (!sessionKey || !sessionId) continue;
    const parentSessionKeyFound = parentOf(entry);
    if (parentSessionKeyFound !== parentSessionKey) continue;
    children.push({
      sessionKey,
      sessionId,
      status: asString(entry.status),
      hasActiveRun: sessionEntryHasActiveRun(entry),
      parentSessionKey: parentSessionKeyFound,
    });
  }
  return children;
}

export function listActiveChildSessions(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
  parentSessionKey: string,
): ChildSessionSnapshot[] {
  return listChildSessions(api, cfg, parentSessionKey).filter((child) => child.hasActiveRun);
}

export function childSessionLooksFailed(child: ChildSessionSnapshot): boolean {
  const status = (child.status ?? "").toLowerCase();
  return FAILED_CHILD_STATUSES.has(status);
}
