import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { projectOperationalAgentEvent, TelemetryManager, type TelemetrySink } from "../src/telemetry/manager.js";
import type { CollectorResult, TelemetryCollector } from "../src/telemetry/types.js";
import type { OperationalEventInput, TelemetryWrite } from "../src/types.js";

function sink() {
  const telemetry: TelemetryWrite[][] = [];
  const events: OperationalEventInput[][] = [];
  const rollups: unknown[] = [];
  const value: TelemetrySink = {
    async writeTelemetry(writes) { telemetry.push(writes); },
    async appendOperationalEvents(input) { events.push(input); },
    async recordOperationalError(input) { rollups.push(input); },
  };
  return { value, telemetry, events, rollups };
}

function manager(collector: TelemetryCollector, output: ReturnType<typeof sink>, now = () => new Date("2026-08-22T12:00:00.000Z")) {
  return new TelemetryManager({
    api: { runtime: {} } as OpenClawPluginApi,
    cfg: {},
    sink: output.value,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    instanceKey: "openclaw:test",
    workerId: "worker",
    heartbeatSeconds: 30,
    collectors: [collector],
    bootId: "boot-a",
    now,
  });
}

afterEach(() => vi.useRealTimers());

describe("adaptive telemetry lifecycle", () => {
  it("backs off unchanged idle state and resets to a fast interval while active", async () => {
    let activity: "active" | "idle" = "idle";
    const collector: TelemetryCollector = {
      id: "sessions", domain: "sessions", intervalMs: 1_000, activeIntervalMs: 100, maxIntervalMs: 8_000, staleAfterMs: 5_000, eventDriven: true,
      async run() { return { authority: "test", activity, writes: [{ table: "state_documents", onConflict: "document_key", rows: [{ document_key: "same" }] }] }; },
    };
    const output = sink();
    const telemetry = manager(collector, output);
    await telemetry.runCollector("sessions");
    await telemetry.runCollector("sessions");
    expect(telemetry.snapshots()[0]?.intervalMs).toBe(2_000);
    activity = "active";
    await telemetry.runCollector("sessions");
    expect(telemetry.snapshots()[0]?.intervalMs).toBe(100);
  });

  it("backs off repeated failure, recovers, and stops unsupported collectors", async () => {
    let mode: "error" | "ok" | "unsupported" = "error";
    const collector: TelemetryCollector = {
      id: "domain", domain: "domain", intervalMs: 1_000, maxIntervalMs: 8_000, staleAfterMs: 5_000, eventDriven: false,
      async run() {
        if (mode === "error") throw new Error("safe failure");
        return { authority: "test", writes: [], ...(mode === "unsupported" ? { freshness: "unsupported" as const, unsupportedReason: "no public API" } : {}) };
      },
    };
    const telemetry = manager(collector, sink());
    await telemetry.runCollector("domain");
    expect(telemetry.snapshots()[0]).toMatchObject({ state: "backoff", failures: 1, intervalMs: 2_000 });
    mode = "ok";
    await telemetry.runCollector("domain");
    expect(telemetry.snapshots()[0]).toMatchObject({ state: "idle", failures: 0, intervalMs: 1_000 });
    mode = "unsupported";
    await telemetry.runCollector("domain");
    expect(telemetry.snapshots()[0]?.state).toBe("unsupported");
    expect(telemetry.trigger("domain")).toBe(false);
  });

  it("suppresses an immediate hook-driven reconciliation after success", async () => {
    const collector: TelemetryCollector = { id: "sessions", domain: "sessions", intervalMs: 20_000, staleAfterMs: 60_000, eventDriven: true, async run() { return { authority: "test", writes: [] }; } };
    const telemetry = manager(collector, sink());
    await telemetry.runCollector("sessions");
    expect(telemetry.trigger("sessions")).toBe(false);
  });

  it("writes heartbeat, connectivity, usage authority, and clean shutdown state", async () => {
    vi.useFakeTimers();
    const output = sink();
    const telemetry = manager({ id: "none", domain: "none", intervalMs: 60_000, staleAfterMs: 60_000, eventDriven: false, async run() { return { authority: "test", writes: [] }; } }, output);
    await telemetry.start();
    telemetry.setRealtimeState("disconnected", "network unavailable");
    telemetry.setRealtimeState("connected");
    telemetry.noteOperation("claim");
    await telemetry.handleHook("llm_output", { runId: "run-1", provider: "openai", model: "gpt-test", usage: { input: 10, output: 2, total: 12 } }, { sessionKey: "agent:main:one", agentId: "main" });
    await Promise.resolve();
    expect(output.telemetry.flatMap((batch) => batch).find((write) => write.table === "model_run_usage")?.rows[0]).toMatchObject({ authority: "openclaw_llm_output_hook", total_tokens: 12, cost_derived: false });
    await telemetry.stop();
    const workerWrites = output.telemetry.flatMap((batch) => batch).filter((write) => write.table === "bridge_workers");
    expect(workerWrites.at(-1)?.rows[0]).toMatchObject({ status: "stopped", realtime_state: "connected", reconnect_count: 1, agent_event_subscription_state: "stopped", active_controller_count: 0 });
  });

  it("rejects duplicate collector ownership", () => {
    const collector: TelemetryCollector = { id: "same", domain: "one", intervalMs: 1_000, staleAfterMs: 1_000, eventDriven: false, async run() { return { authority: "test", writes: [] }; } };
    expect(() => new TelemetryManager({ api: { runtime: {} } as OpenClawPluginApi, cfg: {}, sink: sink().value, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, instanceKey: "i", workerId: "w", heartbeatSeconds: 30, collectors: [collector, collector] })).toThrow(/Duplicate telemetry collector/);
  });

  it("drops high-volume assistant deltas but keeps bounded errors and rollups", async () => {
    vi.useFakeTimers();
    const output = sink();
    const telemetry = manager({ id: "none", domain: "none", intervalMs: 60_000, staleAfterMs: 60_000, eventDriven: false, async run() { return { authority: "test", writes: [] }; } }, output);
    await telemetry.start();
    await telemetry.handleAgentEvent({ runId: "run", seq: 1, stream: "assistant", ts: Date.now(), data: { delta: "private token delta" } });
    expect(output.events).toHaveLength(0);
    await telemetry.handleAgentEvent({ runId: "run", seq: 2, stream: "error", ts: Date.now(), data: { type: "provider_error", errorCategory: "rate_limit", transcript: "private" } });
    expect(output.events).toHaveLength(1);
    expect(output.rollups).toHaveLength(1);
    expect(JSON.stringify(output.events)).not.toContain("private");
    await telemetry.stop();
  });
});

describe("operational event projection", () => {
  it("preserves safe IDs/status while excluding transcripts, cookies, tokens, and env dumps", () => {
    const projected = projectOperationalAgentEvent({
      runId: "run-1", seq: 1, stream: "tool", ts: Date.now(),
      data: { type: "tool_end", status: "ok", toolName: "exec", toolCallId: "call-1", transcript: "private body", cookie: "secret", token: "secret", env: { SECRET: "value" } },
    });
    expect(projected.data).toMatchObject({ type: "tool_end", status: "ok", toolName: "exec", toolCallId: "call-1" });
    expect(JSON.stringify(projected.data)).not.toContain("private body");
    expect(JSON.stringify(projected.data)).not.toContain("SECRET");
  });
});
