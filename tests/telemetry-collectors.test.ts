import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { sessionsCollector, tasksCollector } from "../src/telemetry/collectors/core.js";
import type { CollectorContext } from "../src/telemetry/types.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");

function context(api: unknown): CollectorContext {
  return {
    api: api as OpenClawPluginApi,
    cfg: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    instanceKey: "openclaw:test",
    workerId: "worker",
    bootId: "boot",
    now: NOW,
  };
}

describe("safe session and task mirrors", () => {
  it("mirrors identity, activity, labels, and relationships without transcript bodies", async () => {
    const api = {
      runtime: {
        gateway: { request: vi.fn() },
        agent: {
          session: {
            listSessionEntries: () => [{
              sessionKey: "agent:main:child",
              entry: {
              sessionId: "session-id",
              label: "Safe label",
              displayName: "Safe display",
              parentSessionKey: "agent:main:parent",
              status: "running",
              restartRecoveryDeliveryRunId: "run-id",
              updatedAt: NOW.getTime(),
              prompt: "UNRELATED SECRET PROMPT",
              transcript: [{ role: "assistant", content: "UNRELATED SECRET REPLY" }],
              messages: ["UNRELATED SECRET MESSAGE"],
              },
            }],
          },
        },
      },
    };
    const result = await sessionsCollector.run(context(api));
    const serialized = JSON.stringify(result.writes);
    expect(serialized).toContain("agent:main:child");
    expect(serialized).toContain("agent:main:parent");
    expect(serialized).toContain("Safe label");
    expect(serialized).not.toContain("UNRELATED SECRET");
    expect(result.activity).toBe("active");
    expect(result.writes.find((item) => item.table === "session_active_runs")?.rows).toHaveLength(1);
    expect(sessionsCollector.staleAfterMs).toBeGreaterThan(sessionsCollector.maxIntervalMs ?? 0);
    expect(result.writes.find((item) => item.table === "openclaw_sessions")?.rows[0]?.stale_after)
      .toBe("2026-08-22T12:20:00.000Z");
    expect(api.runtime.gateway.request).not.toHaveBeenCalled();
  });

  it("mirrors OpenClaw task/flow correlation without task prompt bodies", async () => {
    const task = {
      id: "task-1",
      runtime: "native",
      sourceId: "source-1",
      sessionKey: "agent:main:one",
      childSessionKey: "agent:main:child",
      flowId: "flow-1",
      parentTaskId: null,
      agentId: "main",
      runId: "run-1",
      label: "build",
      title: "Operational title",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "owner",
      createdAt: NOW.getTime(),
      prompt: "DO NOT UPLOAD THIS TASK BODY",
    };
    const flow = {
      id: "flow-1",
      ownerKey: "agent:main:one",
      status: "running",
      notifyPolicy: "owner",
      goal: "Operational goal",
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    };
    const api = {
      runtime: {
        agent: { session: { listSessionEntries: () => [{ sessionKey: "agent:main:one" }] } },
        tasks: {
          runs: { bindSession: () => ({ list: () => [task] }) },
          flows: { bindSession: () => ({ list: () => [flow] }) },
        },
      },
    };
    const result = await tasksCollector.run(context(api));
    expect(JSON.stringify(result.writes)).not.toContain("DO NOT UPLOAD");
    expect(result.activity).toBe("active");
    expect(result.writes.find((item) => item.table === "task_flow_members")?.rows[0]).toMatchObject({ flow_id: "flow-1", openclaw_task_id: "task-1" });
  });
});
