import type { FreshnessState, TelemetryRow } from "../types.js";

const MINIMUM_POLLING_GRACE_MS = 5 * 60_000;

export function adaptiveStaleAfterMs(intervalMs: number, maxIntervalMs = intervalMs): number {
  const maximumPollingIntervalMs = Math.max(intervalMs, maxIntervalMs);
  return maximumPollingIntervalMs + Math.max(intervalMs, MINIMUM_POLLING_GRACE_MS);
}

export function freshnessFields(input: {
  observedAt: string;
  ingestedAt?: string;
  staleAfterMs: number;
  bootId: string;
  freshness?: FreshnessState;
  lastChangedAt?: string;
}): TelemetryRow {
  const ingestedAt = input.ingestedAt ?? new Date().toISOString();
  return {
    source_observed_at: input.observedAt,
    ingested_at: ingestedAt,
    last_success_at: input.freshness === "error" ? undefined : ingestedAt,
    last_changed_at: input.lastChangedAt ?? ingestedAt,
    stale_after: new Date(new Date(input.observedAt).getTime() + input.staleAfterMs).toISOString(),
    freshness: input.freshness ?? "fresh",
    boot_id: input.bootId,
  };
}

export function freshnessAt(now: Date, staleAfter: string | null, error?: boolean): FreshnessState {
  if (error) return "error";
  if (!staleAfter) return "stale";
  return new Date(staleAfter).getTime() > now.getTime() ? "fresh" : "stale";
}
