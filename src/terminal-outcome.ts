import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { TerminalWriteInput } from "./types.js";

type EmbeddedAgentResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]>>;

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
