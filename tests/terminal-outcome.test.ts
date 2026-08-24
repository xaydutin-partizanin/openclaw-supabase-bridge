import { describe, expect, it } from "vitest";
import { terminalError, terminalStatus } from "../src/terminal-outcome.js";

function result(input: { meta?: Record<string, unknown>; payloads?: Array<Record<string, unknown>> }) {
  return {
    payloads: input.payloads ?? [],
    meta: { durationMs: 1, ...input.meta },
  } as Parameters<typeof terminalStatus>[0];
}

describe("terminal outcome classification", () => {
  it("completes when an intermediate tool error is followed by a successful terminal outcome", () => {
    const recovered = result({
      meta: { finalAssistantVisibleText: "Implemented, validated, committed, and pushed." },
      payloads: [
        { text: "Tool invocation failed: malformed payload", isError: true },
        { text: "Implemented, validated, committed, and pushed." },
      ],
    });

    expect(terminalStatus(recovered)).toBe("completed");
    expect(terminalError(recovered)).toBeNull();
  });

  it("completes when payload ordering alone shows recovery", () => {
    expect(terminalStatus(result({ payloads: [
      { text: "Tool failed", isError: true },
      { text: "Recovered and completed successfully" },
    ] }))).toBe("completed");
  });

  it("keeps a terminal run-level error failed even if a report payload exists", () => {
    const failed = result({
      meta: { error: { kind: "retry_limit", message: "Retry limit reached" } },
      payloads: [{ text: "Partial report" }],
    });
    expect(terminalStatus(failed)).toBe("failed");
    expect(terminalError(failed)).toBe("Retry limit reached");
  });

  it("keeps a terminal failure signal failed", () => {
    expect(terminalStatus(result({ meta: { failureSignal: {
      kind: "execution_denied", source: "tool", code: "SYSTEM_RUN_DENIED",
      message: "Execution denied", fatalForCron: true,
    } } }))).toBe("failed");
  });

  it("keeps an unrecovered terminal error payload failed", () => {
    const failed = result({ payloads: [{ text: "Terminal tool error", isError: true }] });
    expect(terminalStatus(failed)).toBe("failed");
    expect(terminalError(failed)).toBe("Terminal tool error");
  });

  it("preserves cancellation and timeout classification", () => {
    expect(terminalStatus(result({ meta: { aborted: true } }))).toBe("cancelled");
    expect(terminalStatus(result({ meta: { aborted: true, timeoutPhase: "run" } }))).toBe("timed_out");
  });
});
