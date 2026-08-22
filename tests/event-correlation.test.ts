import { describe, expect, it } from "vitest";
import { buildBridgeEvent, EventCorrelator } from "../src/event-correlator.js";
import type { OpenClawAgentEvent } from "../src/types.js";

function event(overrides: Partial<OpenClawAgentEvent> = {}): OpenClawAgentEvent {
  return {
    runId: "oc-parent-run",
    seq: 1,
    stream: "lifecycle",
    ts: Date.parse("2026-08-22T12:00:00Z"),
    data: { type: "start" },
    sessionKey: "agent:main:supabase-bridge:task-1",
    sessionId: "session-1",
    agentId: "main",
    ...overrides,
  };
}

describe("agent event correlation", () => {
  it("maps parent and spawned child events to one bridge run", () => {
    const correlator = new EventCorrelator();
    correlator.registerParent({
      taskId: "task-1",
      bridgeRunId: "bridge-run-1",
      sessionKey: "agent:main:supabase-bridge:task-1",
      sessionId: "session-1",
    });
    const parent = correlator.correlate(event({ data: { type: "subagent_spawned", childSessionKey: "agent:child:one" } }));
    expect(parent?.bridgeRunId).toBe("bridge-run-1");
    const child = correlator.correlate(event({
      runId: "oc-child-run",
      seq: 1,
      sessionKey: "agent:child:one",
      sessionId: "child-session",
      agentId: "child",
    }));
    expect(child?.bridgeRunId).toBe("bridge-run-1");
  });

  it("ignores unrelated OpenClaw sessions", () => {
    const correlator = new EventCorrelator();
    expect(correlator.correlate(event({ sessionKey: "agent:main:ordinary-chat" }))).toBeNull();
  });

  it("creates the same event key for replayed duplicates", () => {
    const correlator = new EventCorrelator();
    correlator.registerParent({ taskId: "task-1", bridgeRunId: "bridge-run-1", sessionKey: "agent:main:supabase-bridge:task-1", sessionId: "session-1" });
    const correlated = correlator.correlate(event())!;
    expect(buildBridgeEvent(correlated, 10_000)!.eventKey).toBe(buildBridgeEvent(correlated, 10_000)!.eventKey);
  });

  it("drops content streams and projects tool events to safe operational fields", () => {
    const correlator = new EventCorrelator();
    correlator.registerParent({ taskId: "task-1", bridgeRunId: "bridge-run-1", sessionKey: "agent:main:supabase-bridge:task-1", sessionId: "session-1" });
    const assistant = correlator.correlate(event({ stream: "assistant", data: { delta: "private reply" } }))!;
    expect(buildBridgeEvent(assistant, 10_000)).toBeNull();
    const tool = correlator.correlate(event({ stream: "tool", data: { type: "tool_end", toolName: "exec", status: "ok", arguments: { command: "private" }, output: "private output" } }))!;
    expect(buildBridgeEvent(tool, 10_000)?.data).toEqual({ type: "tool_end", toolName: "exec", status: "ok" });
  });
});
