import type { AgentConfigRecord, FallbackReason, ResolvedExecutionConfig } from "./types.js";
import { ExactTargetError } from "./task-targeting.js";

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

export function resolveTargetedExecutionConfig(
  requestedConfig: string | null | undefined,
  targetAgentId: string | null | undefined,
  configs: AgentConfigRecord[],
): ResolvedExecutionConfig {
  const targetAgent = targetAgentId?.trim() || null;
  if (!targetAgent) return resolveExecutionConfig(requestedConfig, configs);

  const requested = requestedConfig?.trim() || null;
  if (requested) {
    const resolved = resolveExecutionConfig(requested, configs);
    if (resolved.fallbackUsed) {
      throw new ExactTargetError("requested_config_unavailable", `Requested config ${requested} is not available`);
    }
    if (resolved.config.agent !== targetAgent) {
      throw new ExactTargetError(
        "agent_config_mismatch",
        `Requested config ${requested} belongs to agent ${resolved.config.agent}, not ${targetAgent}`,
      );
    }
    return resolved;
  }

  const selected = configs.find((config) => config.agent === targetAgent && config.available && config.isDefault)
    ?? configs.find((config) => config.agent === targetAgent && config.available);
  if (!selected) throw new ExactTargetError("agent_unavailable", `No available execution config exists for agent ${targetAgent}`);
  return {
    requestedConfig: null,
    config: selected,
    fallbackUsed: true,
    fallbackReason: "missing_requested_config",
  };
}
