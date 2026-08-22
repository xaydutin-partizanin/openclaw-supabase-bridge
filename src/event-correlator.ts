import { createHash } from "node:crypto";
import { asString } from "./object-utils.js";
import { sanitizeEventData } from "./sanitizer.js";
import type {
  BridgeEvent,
  CorrelatedAgentEvent,
  OpenClawAgentEvent,
} from "./types.js";

interface Correlation {
  taskId: string;
  bridgeRunId: string;
}

export class EventCorrelator {
  readonly #bySourceRun = new Map<string, Correlation>();
  readonly #bySessionKey = new Map<string, Correlation>();
  readonly #bySessionId = new Map<string, Correlation>();

  registerParent(input: {
    taskId: string;
    bridgeRunId: string;
    sessionKey: string;
    sessionId: string;
  }): void {
    const correlation = { taskId: input.taskId, bridgeRunId: input.bridgeRunId };
    // The bridge deliberately passes its UUID as OpenClaw's embedded runId.
    // Registering it up front also covers early events that omit session fields.
    this.#bySourceRun.set(input.bridgeRunId, correlation);
    this.#bySessionKey.set(input.sessionKey, correlation);
    this.#bySessionId.set(input.sessionId, correlation);
  }

  correlate(event: OpenClawAgentEvent): CorrelatedAgentEvent | null {
    let correlation = this.#bySourceRun.get(event.runId);
    if (!correlation && event.sessionKey) correlation = this.#bySessionKey.get(event.sessionKey);
    if (!correlation && event.sessionId) correlation = this.#bySessionId.get(event.sessionId);

    if (!correlation) {
      const parentSessionKey = asString(event.data.parentSessionKey) ?? asString(event.data.spawnedBy);
      const parentSessionId = asString(event.data.parentSessionId);
      if (parentSessionKey) correlation = this.#bySessionKey.get(parentSessionKey);
      if (!correlation && parentSessionId) correlation = this.#bySessionId.get(parentSessionId);
    }
    if (!correlation) return null;

    this.#bySourceRun.set(event.runId, correlation);
    if (event.sessionKey) this.#bySessionKey.set(event.sessionKey, correlation);
    if (event.sessionId) this.#bySessionId.set(event.sessionId, correlation);

    const childSessionKey =
      asString(event.data.childSessionKey) ??
      asString(event.data.child_session_key);
    const childSessionId =
      asString(event.data.childSessionId) ??
      asString(event.data.child_session_id);
    const childRunId = asString(event.data.childRunId) ?? asString(event.data.child_run_id);
    if (childSessionKey) this.#bySessionKey.set(childSessionKey, correlation);
    if (childSessionId) this.#bySessionId.set(childSessionId, correlation);
    if (childRunId) this.#bySourceRun.set(childRunId, correlation);

    return { ...correlation, event };
  }

  sourceRunIdForBridgeRun(bridgeRunId: string): string | null {
    for (const [sourceRunId, correlation] of this.#bySourceRun) {
      if (correlation.bridgeRunId === bridgeRunId) return sourceRunId;
    }
    return null;
  }

  forgetBridgeRun(bridgeRunId: string): void {
    for (const [key, value] of this.#bySourceRun) if (value.bridgeRunId === bridgeRunId) this.#bySourceRun.delete(key);
    for (const [key, value] of this.#bySessionKey) if (value.bridgeRunId === bridgeRunId) this.#bySessionKey.delete(key);
    for (const [key, value] of this.#bySessionId) if (value.bridgeRunId === bridgeRunId) this.#bySessionId.delete(key);
  }
}

function eventType(event: OpenClawAgentEvent): string {
  return (
    asString(event.data.type) ??
    asString(event.data.eventType) ??
    asString(event.data.event_type) ??
    event.stream
  );
}

export function buildBridgeEvent(
  correlated: CorrelatedAgentEvent,
  maxPayloadBytes: number,
): BridgeEvent {
  const { event, bridgeRunId, taskId } = correlated;
  const type = eventType(event);
  const identity = [
    bridgeRunId,
    event.runId,
    event.lifecycleGeneration ?? "",
    String(event.seq),
    event.stream,
    type,
  ].join("|");
  const sanitized = sanitizeEventData(event.data, maxPayloadBytes);
  return {
    eventKey: createHash("sha256").update(identity).digest("hex"),
    taskId,
    runId: bridgeRunId,
    createdAt: new Date().toISOString(),
    eventTs: new Date(event.ts).toISOString(),
    sourceRunId: event.runId,
    sourceSessionKey: event.sessionKey ?? null,
    sourceSessionId: event.sessionId ?? null,
    sourceAgentId: event.agentId ?? null,
    lifecycleGeneration: event.lifecycleGeneration ?? null,
    seq: event.seq,
    stream: event.stream,
    eventType: type,
    data: sanitized.value,
  };
}
