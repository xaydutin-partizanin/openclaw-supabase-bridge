import type { AgentConfigRecord, BridgeTask } from "../src/types.js";

export const NOW = new Date("2026-08-22T12:00:00.000Z");

export function task(overrides: Partial<BridgeTask> = {}): BridgeTask {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    prompt: "Return the word ok.",
    requestedConfig: null,
    status: "pending",
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    metadata: {},
    ...overrides,
  };
}

export function configs(): AgentConfigRecord[] {
  return [
    {
      id: "10000000-0000-4000-8000-000000000001",
      configKey: "main:native:openai:gpt-5-6-sol:low",
      providerId: "20000000-0000-4000-8000-000000000001",
      providerKey: "openai",
      runtime: "native",
      agent: "main",
      model: "gpt-5.6-sol",
      effort: "low",
      available: true,
      isDefault: true,
      other: {},
      updatedAt: NOW.toISOString(),
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      configKey: "cursor:acp:cursor:auto",
      providerId: "20000000-0000-4000-8000-000000000002",
      providerKey: "cursor",
      runtime: "acp",
      agent: "cursor",
      model: null,
      effort: null,
      available: true,
      isDefault: false,
      other: { actual_model_authoritative: false },
      updatedAt: NOW.toISOString(),
    },
    {
      id: "10000000-0000-4000-8000-000000000003",
      configKey: "main:native:deepseek:pro:default",
      providerId: "20000000-0000-4000-8000-000000000003",
      providerKey: "deepseek",
      runtime: "native",
      agent: "main",
      model: "deepseek-v4-pro",
      effort: null,
      available: false,
      isDefault: false,
      other: {},
      updatedAt: NOW.toISOString(),
    },
  ];
}
