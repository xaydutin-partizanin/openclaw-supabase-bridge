import { stopAllBridgeAccounts } from "./runtime-registry.js";

/** OpenClaw host cleanup reasons that reach registerRuntimeLifecycle.cleanup. */
export type BridgeHostCleanupReason = "disable" | "reset" | "delete" | "restart";

/**
 * Bridge account lifetime is owned by the channel start/stop (abort) path.
 * Session reset/delete/restart must not tear down the global bridge controller.
 * Only plugin/channel/Gateway disable (reason === "disable") should stop accounts.
 */
export function shouldStopBridgeOnHostCleanup(reason: string): boolean {
  return reason === "disable";
}

export async function cleanupBridgeRuntimeLifecycle(ctx: {
  reason: string;
  sessionKey?: string;
  runId?: string;
}): Promise<"stopped" | "ignored"> {
  if (!shouldStopBridgeOnHostCleanup(ctx.reason)) {
    return "ignored";
  }
  await stopAllBridgeAccounts();
  return "stopped";
}
