import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { BridgeLogger } from "../controller.js";
import type { FreshnessState, TelemetryWrite } from "../types.js";

export interface CollectorContext {
  api: OpenClawPluginApi;
  cfg: OpenClawConfig;
  logger: BridgeLogger;
  instanceKey: string;
  workerId: string;
  bootId: string;
  now: Date;
}

export interface CollectorResult {
  writes: TelemetryWrite[];
  observedAt?: string;
  authority: string;
  freshness?: FreshnessState;
  unsupportedReason?: string;
  activity?: "active" | "idle";
}

export interface TelemetryCollector {
  id: string;
  domain: string;
  intervalMs: number;
  activeIntervalMs?: number;
  maxIntervalMs?: number;
  staleAfterMs: number;
  eventDriven: boolean;
  run(context: CollectorContext): Promise<CollectorResult>;
}

export interface CollectorSnapshot {
  id: string;
  domain: string;
  state: "idle" | "running" | "backoff" | "unsupported" | "stopped";
  failures: number;
  intervalMs: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  eventDriven: boolean;
}
