import type { AgentConfigRecord, FallbackReason, ResolvedExecutionConfig } from "./types.js";

export class MissingDefaultConfigError extends Error {
  constructor() {
    super("No available default OpenClaw execution configuration exists");
    this.name = "MissingDefaultConfigError";
  }
}

function availableDefault(configs: AgentConfigRecord[]): AgentConfigRecord {
  const selected = configs.find((config) => config.isDefault && config.available);
  if (!selected) throw new MissingDefaultConfigError();
  return selected;
}

export function resolveExecutionConfig(
  requestedConfig: string | null | undefined,
  configs: AgentConfigRecord[],
): ResolvedExecutionConfig {
  const requested = requestedConfig?.trim() || null;
  let reason: FallbackReason | null = null;

  if (!requested) {
    reason = "missing_requested_config";
  } else {
    const match = configs.find((config) => config.configKey === requested);
    if (!match) {
      reason = "unknown_config";
    } else if (!match.available) {
      reason = "config_unavailable";
    } else {
      return {
        requestedConfig: requested,
        config: match,
        fallbackUsed: false,
        fallbackReason: null,
      };
    }
  }

  return {
    requestedConfig: requested,
    config: availableDefault(configs),
    fallbackUsed: true,
    fallbackReason: reason,
  };
}
