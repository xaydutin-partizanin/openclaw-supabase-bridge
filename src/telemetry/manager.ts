import { createHash, randomUUID } from "node:crypto";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { BridgeLogger } from "../controller.js";
import { errorMessage } from "../object-utils.js";
import { sanitizeEventData } from "../sanitizer.js";
import type { Json, OpenClawAgentEvent, OperationalEventInput, TelemetryRow, TelemetryWrite } from "../types.js";
import { safeMetadata, stableHash, stableKey, write } from "./collector-utils.js";
import { freshnessFields } from "./freshness.js";
import type { CollectorContext, CollectorSnapshot, TelemetryCollector } from "./types.js";

const MINUTE = 60_000;
const OPERATIONAL_AGENT_STREAMS = new Set(["lifecycle", "error", "approval", "acp", "compaction"]);

export interface TelemetrySink {
  writeTelemetry(writes: TelemetryWrite[]): Promise<void>;
  appendOperationalEvents(events: OperationalEventInput[]): Promise<void>;
  recordOperationalError(input: {
    rollupKey: string;
    instanceKey: string;
    domain: string;
    errorCode: string;
    observedAt: string;
    summary: string;
    bootId: string;
  }): Promise<void>;
}

interface CollectorRuntimeState {
  collector: TelemetryCollector;
  state: CollectorSnapshot["state"];
  failures: number;
  currentIntervalMs: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  nextRunAt: Date | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  lastSignature: string | null;
  unchangedRuns: number;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function operationEventKey(parts: Array<string | number | null | undefined>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function contentSignature(writes: TelemetryWrite[]): string {
  const temporal = new Set([
    "source_observed_at", "ingested_at", "last_success_at", "last_changed_at", "stale_after", "boot_id",
  ]);
  const stable = writes.map((batch) => ({
    table: batch.table,
    onConflict: batch.onConflict,
    rows: batch.rows.map((row) => Object.fromEntries(
      Object.entries(row).filter(([key]) => !temporal.has(key)),
    )),
  }));
  return stableHash(JSON.stringify(stable));
}

export function projectOperationalAgentEvent(event: OpenClawAgentEvent): { type: string; severity: OperationalEventInput["severity"]; data: Record<string, Json> } {
  const data = event.data;
  const type = typeof data.type === "string" ? data.type : `${event.stream}_event`;
  const severity: OperationalEventInput["severity"] = event.stream === "error" ? "error" : event.stream === "approval" ? "warning" : "info";
  const allow = [
    "type", "phase", "status", "outcome", "toolName", "tool", "durationMs", "backend", "provider", "model",
    "reason", "failureKind", "errorCategory", "itemId", "toolCallId", "taskId", "flowId", "terminalOutcome",
  ];
  const projected: Record<string, unknown> = {};
  for (const key of allow) if (data[key] !== undefined) projected[key] = data[key];
  return { type, severity, data: sanitizeEventData(projected, 8_192).value };
}

export class TelemetryManager {
  readonly #api: OpenClawPluginApi;
  readonly #cfg: OpenClawConfig;
  readonly #sink: TelemetrySink;
  readonly #logger: BridgeLogger;
  readonly #instanceKey: string;
  readonly #workerId: string;
  readonly #bootId: string;
  readonly #heartbeatMs: number;
  readonly #states = new Map<string, CollectorRuntimeState>();
  readonly #now: () => Date;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #stopped = false;
  #realtimeState: "connecting" | "connected" | "disconnected" | "error" = "connecting";
  #reconnectCount = 0;
  #lastRealtimeError: string | null = null;
  #agentEventSubscriptionState: "registered" | "stopped" = "registered";
  #startedAt: string | null = null;
  #lastClaimAt: string | null = null;
  #lastReportAt: string | null = null;
  #lastEventFlushAt: string | null = null;
  #lastTelemetrySyncAt: string | null = null;

  constructor(input: {
    api: OpenClawPluginApi;
    cfg: OpenClawConfig;
    sink: TelemetrySink;
    logger: BridgeLogger;
    instanceKey: string;
    workerId: string;
    heartbeatSeconds: number;
    collectors: TelemetryCollector[];
    bootId?: string;
    now?: () => Date;
  }) {
    this.#api = input.api;
    this.#cfg = input.cfg;
    this.#sink = input.sink;
    this.#logger = input.logger;
    this.#instanceKey = input.instanceKey;
    this.#workerId = input.workerId;
    this.#heartbeatMs = input.heartbeatSeconds * 1_000;
    this.#bootId = input.bootId ?? randomUUID();
    this.#now = input.now ?? (() => new Date());
    for (const collector of input.collectors) {
      if (this.#states.has(collector.id)) throw new Error(`Duplicate telemetry collector id: ${collector.id}`);
      this.#states.set(collector.id, {
        collector,
        state: "idle",
        failures: 0,
        currentIntervalMs: collector.intervalMs,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        nextRunAt: null,
        timer: null,
        running: null,
        lastSignature: null,
        unchangedRuns: 0,
      });
    }
  }

  get bootId(): string {
    return this.#bootId;
  }

  get started(): boolean {
    return this.#started && !this.#stopped;
  }

  snapshots(): CollectorSnapshot[] {
    return [...this.#states.values()].map((state) => ({
      id: state.collector.id,
      domain: state.collector.domain,
      state: state.state,
      failures: state.failures,
      intervalMs: state.currentIntervalMs,
      lastAttemptAt: state.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
      lastError: state.lastError,
      nextRunAt: state.nextRunAt?.toISOString() ?? null,
      eventDriven: state.collector.eventDriven,
    }));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.#started = true;
    this.#stopped = false;
    this.#startedAt = this.#now().toISOString();
    for (const state of this.#states.values()) this.#schedule(state, 0);
    this.#heartbeatTimer = setInterval(() => void this.#writeSelfHealth(), this.#heartbeatMs);
    this.#heartbeatTimer.unref?.();
    await this.#writeSelfHealth();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#agentEventSubscriptionState = "stopped";
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    const running: Promise<void>[] = [];
    for (const state of this.#states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.nextRunAt = null;
      state.state = "stopped";
      if (state.running) running.push(state.running);
    }
    await Promise.allSettled(running);
    await this.#writeSelfHealth();
  }

  setRealtimeState(state: "connecting" | "connected" | "disconnected" | "error", detail?: string): void {
    const wasUnavailable = this.#realtimeState === "disconnected" || this.#realtimeState === "error";
    if (state === "connected" && wasUnavailable) this.#reconnectCount += 1;
    this.#realtimeState = state;
    this.#lastRealtimeError = state === "error" || state === "disconnected" ? detail ?? state : null;
    void this.#writeSelfHealth();
  }

  noteOperation(kind: "claim" | "report" | "event_flush"): void {
    const at = this.#now().toISOString();
    if (kind === "claim") this.#lastClaimAt = at;
    if (kind === "report") this.#lastReportAt = at;
    if (kind === "event_flush") this.#lastEventFlushAt = at;
    void this.#writeSelfHealth();
  }

  trigger(domain: string): boolean {
    let scheduled = false;
    const now = this.#now();
    for (const state of this.#states.values()) {
      if (state.collector.domain !== domain && state.collector.id !== domain) continue;
      if (state.state === "unsupported" || state.state === "stopped" || state.running) continue;
      const suppressionMs = Math.min(5_000, Math.floor(state.collector.intervalMs / 4));
      if (state.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() < suppressionMs) continue;
      this.#schedule(state, 0);
      scheduled = true;
    }
    return scheduled;
  }

  async runCollector(id: string): Promise<void> {
    const state = this.#states.get(id);
    if (!state) throw new Error(`Unknown collector: ${id}`);
    if (state.running) return state.running;
    const promise = this.#execute(state).finally(() => {
      state.running = null;
    });
    state.running = promise;
    return promise;
  }

  async handleAgentEvent(event: OpenClawAgentEvent): Promise<void> {
    if (!this.started) return;
    if (!OPERATIONAL_AGENT_STREAMS.has(event.stream)) return;
    const safe = projectOperationalAgentEvent(event);
    const eventTs = new Date(event.ts).toISOString();
    await this.#sink.appendOperationalEvents([{
      eventKey: operationEventKey([this.#instanceKey, event.runId, event.seq, event.stream]),
      instanceKey: this.#instanceKey,
      bootId: this.#bootId,
      source: "openclaw_agent_event",
      domain: event.stream === "tool" || event.stream === "command_output" ? "tools" : "agent-runs",
      severity: safe.severity,
      eventType: safe.type,
      eventTs,
      agentId: event.agentId ?? null,
      sessionKey: event.sessionKey ?? null,
      sessionId: event.sessionId ?? null,
      runId: event.runId,
      summary: null,
      data: safe.data,
    }]);
    if (safe.severity === "error") {
      const window = eventTs.slice(0, 13);
      await this.#sink.recordOperationalError({
        rollupKey: stableHash(this.#instanceKey, event.stream, safe.type, window),
        instanceKey: this.#instanceKey,
        domain: event.stream,
        errorCode: safe.type,
        observedAt: eventTs,
        summary: `${event.stream} emitted ${safe.type}`,
        bootId: this.#bootId,
      });
    }
    if (event.stream === "lifecycle" || event.stream === "error") {
      this.trigger("sessions");
      this.trigger("tasks");
    }
  }

  async handleHook(name: string, event: unknown, hookContext?: unknown): Promise<void> {
    if (!this.started) return;
    const record = event && typeof event === "object" ? event as Record<string, unknown> : {};
    const ctx = hookContext && typeof hookContext === "object" ? hookContext as Record<string, unknown> : {};
    const runId = typeof record.runId === "string" ? record.runId : typeof ctx.runId === "string" ? ctx.runId : null;
    const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : typeof ctx.sessionId === "string" ? ctx.sessionId : null;
    const agentId = typeof ctx.agentId === "string" ? ctx.agentId : typeof record.agentId === "string" ? record.agentId : null;
    const observedAt = nowIso(this.#now());
    const safe = safeMetadata({
      status: record.status,
      outcome: record.outcome,
      reason: record.reason,
      duration_ms: record.durationMs,
      provider: record.provider,
      model: record.model,
      harness_id: record.harnessId,
      tool_name: record.toolName,
      action: record.action,
      job_id: record.jobId,
      target_kind: record.targetKind,
    }, 8_192);
    await this.#sink.appendOperationalEvents([{
      eventKey: operationEventKey([this.#instanceKey, this.#bootId, name, runId, sessionKey, observedAt]),
      instanceKey: this.#instanceKey,
      bootId: this.#bootId,
      source: "openclaw_plugin_hook",
      domain: name.startsWith("session_") ? "sessions" : name.startsWith("subagent_") ? "tasks" : name === "cron_changed" ? "cron" : "agent-runs",
      severity: record.error ? "error" : "info",
      eventType: name,
      eventTs: observedAt,
      agentId,
      sessionKey,
      sessionId,
      runId,
      summary: null,
      data: safe,
    }]);
    if (record.error) {
      const window = observedAt.slice(0, 13);
      await this.#sink.recordOperationalError({
        rollupKey: stableHash(this.#instanceKey, "hook", name, window),
        instanceKey: this.#instanceKey,
        domain: name,
        errorCode: name,
        observedAt,
        summary: `OpenClaw hook ${name} reported an error`,
        bootId: this.#bootId,
      });
    }

    if (name === "llm_output" && runId) {
      const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : {};
      const provider = typeof record.provider === "string" ? record.provider : "unknown";
      const model = typeof record.model === "string" ? record.model : "unknown";
      const row: TelemetryRow = {
        usage_key: stableHash(this.#instanceKey, runId, provider, model, observedAt),
        instance_key: this.#instanceKey,
        run_id: runId,
        session_key: sessionKey,
        session_id: sessionId,
        agent_id: agentId,
        provider_key: provider,
        model,
        harness_id: typeof record.harnessId === "string" ? record.harnessId : null,
        input_tokens: typeof usage.input === "number" ? usage.input : null,
        output_tokens: typeof usage.output === "number" ? usage.output : null,
        cache_read_tokens: typeof usage.cacheRead === "number" ? usage.cacheRead : null,
        cache_write_tokens: typeof usage.cacheWrite === "number" ? usage.cacheWrite : null,
        total_tokens: typeof usage.total === "number" ? usage.total : null,
        cost_amount: null,
        cost_currency: null,
        cost_derived: false,
        authority: "openclaw_llm_output_hook",
        source_observed_at: observedAt,
        ingested_at: observedAt,
        last_success_at: observedAt,
        last_changed_at: observedAt,
        stale_after: new Date(this.#now().getTime() + 60 * MINUTE).toISOString(),
        freshness: "fresh",
        boot_id: this.#bootId,
      };
      await this.#sink.writeTelemetry([write("model_run_usage", "usage_key", [row])]);
    }

    if (name === "cron_changed" && typeof record.jobId === "string") {
      const row: TelemetryRow = {
        cron_run_key: stableHash(this.#instanceKey, record.jobId, record.runId as string | undefined, record.runAtMs as number | undefined, record.action as string | undefined),
        instance_key: this.#instanceKey,
        cron_id: record.jobId,
        run_id: runId,
        session_key: sessionKey,
        status: typeof record.status === "string" ? record.status : typeof record.action === "string" ? record.action : "observed",
        started_at: typeof record.runAtMs === "number" ? new Date(record.runAtMs).toISOString() : null,
        duration_ms: typeof record.durationMs === "number" ? record.durationMs : null,
        error: typeof record.error === "string" ? sanitizeEventData({ error: record.error }, 2_048).value.error ?? null : null,
        summary: typeof record.summary === "string" ? record.summary.slice(0, 2_000) : null,
        ...freshnessFields({ observedAt, staleAfterMs: 60 * MINUTE, bootId: this.#bootId }),
      };
      await this.#sink.writeTelemetry([write("cron_runs", "cron_run_key", [row])]);
    }

    if (name.startsWith("session_") || name.startsWith("subagent_") || name === "agent_end") {
      this.trigger("sessions");
      this.trigger("tasks");
    }
    if (name === "cron_changed") this.trigger("cron");
    if (name === "gateway_start" || name === "gateway_stop") this.trigger("gateway");
  }

  #schedule(state: CollectorRuntimeState, delayMs: number): void {
    if (this.#stopped || state.state === "unsupported") return;
    if (state.timer) clearTimeout(state.timer);
    state.nextRunAt = new Date(this.#now().getTime() + Math.max(0, delayMs));
    state.timer = setTimeout(() => {
      state.timer = null;
      state.nextRunAt = null;
      void this.runCollector(state.collector.id);
    }, Math.max(0, delayMs));
    state.timer.unref?.();
  }

  async #execute(state: CollectorRuntimeState): Promise<void> {
    if (this.#stopped || state.state === "unsupported") return;
    const startedAt = this.#now();
    state.state = "running";
    state.lastAttemptAt = startedAt;
    let outcome: "success" | "error" | "unsupported" = "success";
    let resultAuthority = "unknown";
    try {
      const context: CollectorContext = {
        api: this.#api,
        cfg: this.#cfg,
        logger: this.#logger,
        instanceKey: this.#instanceKey,
        workerId: this.#workerId,
        bootId: this.#bootId,
        now: startedAt,
      };
      const result = await state.collector.run(context);
      resultAuthority = result.authority;
      if (result.writes.length) await this.#sink.writeTelemetry(result.writes);
      const signature = contentSignature(result.writes);
      const unchanged = state.lastSignature === signature;
      state.lastSignature = signature;
      state.unchangedRuns = unchanged ? state.unchangedRuns + 1 : 0;
      state.lastSuccessAt = this.#now();
      state.lastError = null;
      state.failures = 0;
      if (result.activity === "active") {
        state.currentIntervalMs = state.collector.activeIntervalMs ?? state.collector.intervalMs;
      } else if (unchanged) {
        state.currentIntervalMs = Math.min(
          state.collector.maxIntervalMs ?? state.collector.intervalMs * 8,
          Math.max(state.collector.intervalMs, state.currentIntervalMs * 2),
        );
      } else {
        state.currentIntervalMs = state.collector.intervalMs;
      }
      if (result.freshness === "unsupported" || result.unsupportedReason) {
        outcome = "unsupported";
        state.state = "unsupported";
      } else {
        state.state = "idle";
      }
    } catch (error) {
      outcome = "error";
      state.failures += 1;
      state.lastError = errorMessage(error);
      state.currentIntervalMs = Math.min(
        state.collector.maxIntervalMs ?? 60 * MINUTE,
        state.collector.intervalMs * 2 ** Math.min(state.failures, 6),
      );
      state.state = "backoff";
      this.#logger.warn("Supabase Bridge telemetry collector failed", {
        collector: state.collector.id,
        error: state.lastError,
        failures: state.failures,
      });
    }

    const finishedAt = this.#now();
    const syncRow: TelemetryRow = {
      sync_run_key: stableHash(this.#instanceKey, this.#bootId, state.collector.id, startedAt.toISOString()),
      instance_key: this.#instanceKey,
      worker_id: this.#workerId,
      boot_id: this.#bootId,
      collector_id: state.collector.id,
      domain: state.collector.domain,
      status: outcome,
      authority: resultAuthority,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      error: state.lastError ? sanitizeEventData({ error: state.lastError }, 4_096).value.error ?? null : null,
      ingested_at: finishedAt.toISOString(),
    };
    try {
      await this.#sink.writeTelemetry([write("telemetry_sync_runs", "sync_run_key", [syncRow])]);
      if (outcome === "success") this.#lastTelemetrySyncAt = finishedAt.toISOString();
      await this.#writeSelfHealth();
    } catch (error) {
      this.#logger.debug?.("Supabase Bridge telemetry self-health write failed", { error: errorMessage(error) });
    }
    if (!this.#stopped && state.state !== "unsupported") this.#schedule(state, state.currentIntervalMs);
  }

  async #writeSelfHealth(): Promise<void> {
    const now = this.#now();
    const observedAt = now.toISOString();
    const workerRow: TelemetryRow = {
      worker_key: stableKey(this.#instanceKey, this.#workerId),
      instance_key: this.#instanceKey,
      worker_id: this.#workerId,
      boot_id: this.#bootId,
      plugin_version: this.#api.version ?? "0.2.3",
      status: this.#stopped ? "stopped" : "running",
      heartbeat_at: observedAt,
      supabase_state: this.#realtimeState === "connected" ? "connected" : "degraded",
      realtime_state: this.#realtimeState,
      agent_event_subscription_state: this.#agentEventSubscriptionState,
      reconnect_count: this.#reconnectCount,
      buffered_event_count: 0,
      active_controller_count: this.#stopped ? 0 : 1,
      last_error: this.#lastRealtimeError,
      last_claim_at: this.#lastClaimAt,
      last_report_at: this.#lastReportAt,
      last_event_flush_at: this.#lastEventFlushAt,
      last_telemetry_sync_at: this.#lastTelemetrySyncAt,
      started_at: this.#startedAt,
      stopped_at: this.#stopped ? observedAt : null,
      ...freshnessFields({ observedAt, staleAfterMs: Math.max(this.#heartbeatMs * 3, 90_000), bootId: this.#bootId }),
    };
    const collectorRows = this.snapshots().map((snapshot): TelemetryRow => ({
      collector_key: stableKey(this.#instanceKey, this.#workerId, snapshot.id),
      instance_key: this.#instanceKey,
      worker_id: this.#workerId,
      boot_id: this.#bootId,
      collector_id: snapshot.id,
      domain: snapshot.domain,
      status: snapshot.state,
      event_driven: snapshot.eventDriven,
      current_interval_ms: snapshot.intervalMs,
      consecutive_failures: snapshot.failures,
      last_attempt_at: snapshot.lastAttemptAt,
      last_success_at: snapshot.lastSuccessAt,
      next_run_at: snapshot.nextRunAt,
      last_error: snapshot.lastError,
      source_observed_at: observedAt,
      ingested_at: observedAt,
      last_changed_at: observedAt,
      stale_after: new Date(now.getTime() + Math.max(this.#heartbeatMs * 3, 90_000)).toISOString(),
      freshness: snapshot.state === "unsupported" ? "unsupported" : snapshot.state === "backoff" ? "error" : "fresh",
    }));
    await this.#sink.writeTelemetry([
      write("bridge_workers", "worker_key", [workerRow]),
      write("telemetry_collectors", "collector_key", collectorRows),
    ]);
  }
}
