import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { asRecord, asString, toJson } from "./object-utils.js";
import type { AgentConfigRecord, InventorySnapshot, Json, ProviderRecord } from "./types.js";

interface AgentDescriptor {
  id: string;
  runtime: "native" | "acp";
  runtimeConfig: Record<string, unknown>;
}

function stablePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function providerDisplayName(provider: string): string {
  const known: Record<string, string> = {
    openai: "OpenAI",
    deepseek: "DeepSeek",
    cursor: "Cursor",
  };
  return known[provider] ?? provider.replace(/(^|[-_])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function providerQuotaCapability(provider: string): string {
  if (provider === "openai" || provider === "deepseek") return "provider_usage_endpoint";
  if (provider === "cursor") return "cursor_internal_api";
  return "unsupported";
}

function readAgents(cfg: OpenClawConfig): AgentDescriptor[] {
  const agentsRoot = asRecord(asRecord(cfg).agents);
  const configured = Array.isArray(agentsRoot.list) ? agentsRoot.list : [];
  const agents = configured
    .map((entry) => asRecord(entry))
    .map((entry): AgentDescriptor | null => {
      const id = asString(entry.id);
      if (!id) return null;
      const runtimeConfig = asRecord(entry.runtime);
      return {
        id,
        runtime: asString(runtimeConfig.type) === "acp" ? "acp" : "native",
        runtimeConfig,
      };
    })
    .filter((entry): entry is AgentDescriptor => entry !== null);
  return agents.length ? agents : [{ id: "main", runtime: "native", runtimeConfig: {} }];
}

function readModelRefs(cfg: OpenClawConfig): string[] {
  const defaults = asRecord(asRecord(asRecord(cfg).agents).defaults);
  const configuredModels = asRecord(defaults.models);
  const refs = Object.keys(configuredModels).filter((ref) => ref.includes("/"));
  const primary = asString(asRecord(defaults.model).primary);
  if (primary && !refs.includes(primary)) refs.unshift(primary);
  return refs;
}

function readPrimaryModel(cfg: OpenClawConfig): string | null {
  return asString(asRecord(asRecord(asRecord(asRecord(cfg).agents).defaults).model).primary);
}

function modelAlias(cfg: OpenClawConfig, modelRef: string): string | null {
  const defaults = asRecord(asRecord(asRecord(cfg).agents).defaults);
  return asString(asRecord(asRecord(defaults.models)[modelRef]).alias);
}

async function probeNativeProvider(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
  provider: string,
  workspaceDir: string | undefined,
): Promise<{ available: boolean; authMode: string | null; source: string }> {
  try {
    const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
      provider,
      cfg,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
    return {
      available: Boolean(auth.apiKey || auth.mode === "aws-sdk"),
      authMode: auth.mode,
      source: auth.source,
    };
  } catch {
    return { available: false, authMode: null, source: "unavailable" };
  }
}

export async function discoverInventory(api: OpenClawPluginApi, cfg: OpenClawConfig): Promise<InventorySnapshot> {
  const now = new Date().toISOString();
  const agents = readAgents(cfg);
  const nativeAgents = agents.filter((agent) => agent.runtime === "native");
  const acpAgents = agents.filter((agent) => agent.runtime === "acp");
  const modelRefs = readModelRefs(cfg);
  const primaryModel = readPrimaryModel(cfg);
  const defaultNativeAgent = nativeAgents.find((agent) => agent.id === "main") ?? nativeAgents[0];
  const providers = new Map<string, ProviderRecord>();
  const configs: AgentConfigRecord[] = [];
  const providerAvailability = new Map<string, boolean>();

  for (const modelRef of modelRefs) {
    const separator = modelRef.indexOf("/");
    if (separator < 1) continue;
    const provider = modelRef.slice(0, separator);
    const model = modelRef.slice(separator + 1);
    if (!providerAvailability.has(provider)) {
      const workspaceDir = defaultNativeAgent
        ? api.runtime.agent.resolveAgentWorkspaceDir(cfg, defaultNativeAgent.id)
        : undefined;
      const probe = await probeNativeProvider(api, cfg, provider, workspaceDir);
      providerAvailability.set(provider, probe.available);
      providers.set(provider, {
        providerKey: provider,
        name: providerDisplayName(provider),
        available: probe.available,
        metadata: {
          runtime: "native",
          auth_mechanism: probe.authMode ?? "unknown",
          auth_source: probe.source,
          openclaw_version: api.runtime.version,
          quota_introspection: providerQuotaCapability(provider),
        },
        updatedAt: now,
      });
    }

    for (const agent of nativeAgents) {
      const policy = api.runtime.agent.resolveThinkingPolicy({ provider, model, agentRuntime: "native" });
      const levels = policy.levels.length ? policy.levels.map((level) => level.id) : [null];
      for (const effort of levels) {
        const alias = modelAlias(cfg, modelRef);
        const configKey = [agent.id, "native", provider, model, effort ?? "default"].map(stablePart).join(":");
        const isDefault =
          agent.id === defaultNativeAgent?.id &&
          modelRef === primaryModel &&
          effort === (policy.defaultLevel ?? null);
        configs.push({
          configKey,
          providerKey: provider,
          runtime: "native",
          agent: agent.id,
          model,
          effort,
          available: providerAvailability.get(provider) === true,
          isDefault,
          other: {
            model_ref: modelRef,
            ...(alias ? { alias } : {}),
            thinking_policy_source: "openclaw_runtime",
          },
          updatedAt: now,
        });
      }
    }
  }

  for (const agent of acpAgents) {
    const acp = asRecord(agent.runtimeConfig.acp);
    const provider = asString(acp.agent) ?? agent.id;
    const backend = asString(acp.backend) ?? "unknown";
    const mode = asString(acp.mode) ?? "unknown";
    const available = Boolean(provider && backend);
    providers.set(provider, {
      providerKey: provider,
      name: providerDisplayName(provider),
      available,
      metadata: {
        runtime: "acp",
        mediated_by: backend,
        availability_source: "configured_acp_agent",
        actual_model_authoritative: false,
        quota_introspection: "unsupported",
        openclaw_version: api.runtime.version,
      },
      updatedAt: now,
    });
    configs.push({
      configKey: [agent.id, "acp", provider, "auto"].map(stablePart).join(":"),
      providerKey: provider,
      runtime: "acp",
      agent: agent.id,
      model: null,
      effort: null,
      available,
      isDefault: false,
      other: toJson({
        harness_agent: provider,
        backend,
        mode,
        cwd: asString(acp.cwd),
        actual_model_authoritative: false,
      }) as Record<string, Json>,
      updatedAt: now,
    });
  }

  if (!configs.some((config) => config.isDefault)) {
    const candidate = configs.find((config) => config.available && config.runtime === "native");
    if (candidate) candidate.isDefault = true;
  }

  return { providers: [...providers.values()], configs, refreshedAt: now };
}
