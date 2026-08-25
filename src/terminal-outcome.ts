import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { TerminalWriteInput } from "./types.js";

type EmbeddedAgentResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]>>;

function toolNames(result: EmbeddedAgentResult): string[] {
  const tools = result.meta.toolSummary?.tools;
  return Array.isArray(tools) ? tools.map(String) : [];
}

/**
 * Parent turned ended after spawning/yielding to implementation children.
 * Tool-error payloads from the orchestration turn are not the run outcome.
 */
export function orchestrationHandedOff(result: EmbeddedAgentResult): boolean {
  const tools = toolNames(result);
  if (tools.includes("sessions_yield") || tools.includes("sessions_spawn")) return true;
  return (result.acceptedSessionSpawns?.length ?? 0) > 0;
}

function hasSuccessfulTerminalAssistant(result: EmbeddedAgentResult): boolean {
  if (result.meta.finalAssistantVisibleText?.trim() || result.meta.finalAssistantRawText?.trim()) return true;

  const lastVisiblePayload = (result.payloads ?? []).findLast(
    (payload) => !payload.isReasoning && !payload.isCommentary && payload.text?.trim(),
  );
  return Boolean(lastVisiblePayload && !lastVisiblePayload.isError);
}

/** Classify only the terminal run outcome; earlier tool/payload errors are recoverable. */
export function terminalStatus(result: EmbeddedAgentResult): TerminalWriteInput["status"] {
  if (result.meta.aborted) return result.meta.timeoutPhase ? "timed_out" : "cancelled";
  if (result.meta.error || result.meta.failureSignal) return "failed";
  if (hasSuccessfulTerminalAssistant(result)) return "completed";

  // Yield/spawn handoff: parent orchestration ended; do not treat the last tool
  // error (e.g. a failed bash probe) as the bridge task outcome.
  if (orchestrationHandedOff(result)) return "completed";

  const lastVisiblePayload = (result.payloads ?? []).findLast(
    (payload) => !payload.isReasoning && !payload.isCommentary && payload.text?.trim(),
  );
  return lastVisiblePayload?.isError ? "failed" : "completed";
}

export function terminalError(result: EmbeddedAgentResult): string | null {
  return result.meta.error?.message
    ?? result.meta.failureSignal?.message
    ?? (terminalStatus(result) === "failed"
      ? (result.payloads ?? []).findLast((payload) => payload.isError && payload.text?.trim())?.text?.trim() ?? null
      : null);
}

/** Prefer a non-error visible report; avoid surfacing orchestration tool failures after yield. */
export function extractReportText(result: EmbeddedAgentResult): string {
  const preferred = result.meta.finalAssistantVisibleText?.trim();
  if (preferred) return preferred;

  const visiblePayloads = (result.payloads ?? [])
    .filter((payload) => !payload.isReasoning && !payload.isCommentary && payload.text?.trim())
    .map((payload) => ({ text: payload.text!.trim(), isError: Boolean(payload.isError) }));

  if (orchestrationHandedOff(result)) {
    const nonError = visiblePayloads.findLast((payload) => !payload.isError);
    if (nonError) return nonError.text;
    const raw = result.meta.finalAssistantRawText?.trim();
    if (raw) return raw;
    return "Parent orchestration handed off to an implementation child session.";
  }

  if (visiblePayloads.length) return visiblePayloads.at(-1)!.text;
  const raw = result.meta.finalAssistantRawText?.trim();
  if (raw) return raw;
  return "OpenClaw finished without a visible assistant report.";
}
