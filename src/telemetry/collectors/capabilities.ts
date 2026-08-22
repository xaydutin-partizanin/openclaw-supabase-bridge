import { asBoolean, asRecord, asString } from "../../object-utils.js";
import type { TelemetryRow } from "../../types.js";
import { json, nullableString, observedRow, rows, stableKey, write } from "../collector-utils.js";
import type { CollectorContext, CollectorResult, TelemetryCollector } from "../types.js";

const MINUTE = 60_000;

async function request(context: CollectorContext, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return context.api.runtime.gateway.request(method, params);
}

function modelRows(context: CollectorContext, result: Record<string, unknown>, observedAt: string, staleAfterMs: number): TelemetryRow[] {
  return rows(result, "models").flatMap((model): TelemetryRow[] => {
    const provider = asString(model.provider) ?? asString(model.providerId);
    const id = asString(model.id) ?? asString(model.model);
    if (!provider || !id) return [];
    return [observedRow({
      row: {
        model_key: stableKey(context.instanceKey, provider, id),
        instance_key: context.instanceKey,
        provider_key: provider,
        model_id: id,
        display_name: nullableString(model.name) ?? id,
        available: model.available === undefined ? true : asBoolean(model.available, false),
        context_tokens: typeof model.contextTokens === "number" ? model.contextTokens : null,
        input_modalities: json(model.input ?? model.modalities ?? []),
        capabilities: json({
          reasoning: model.reasoning,
          tools: model.tools,
          vision: model.vision,
        }),
      },
      observedAt,
      staleAfterMs,
      bootId: context.bootId,
    })];
  });
}

export const modelsCollector: TelemetryCollector = {
  id: "models",
  domain: "models",
  intervalMs: 15 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: 30 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const [modelValue, authValue, agentValue] = await Promise.all([
      request(context, "models.list"),
      request(context, "models.authStatus"),
      request(context, "agents.list"),
    ]);
    const models = asRecord(modelValue);
    const auth = asRecord(authValue);
    const agents = asRecord(agentValue);
    const observedAt = context.now.toISOString();
    const mappedModels = modelRows(context, models, observedAt, this.staleAfterMs);
    const authRows: TelemetryRow[] = [];
    const providerValues = Array.isArray(auth.providers) ? auth.providers : [];
    for (const providerValue of providerValues) {
      const provider = asRecord(providerValue);
      const id = asString(provider.provider) ?? asString(provider.id);
      if (!id) continue;
      authRows.push(observedRow({
        row: {
          auth_key: stableKey(context.instanceKey, id),
          instance_key: context.instanceKey,
          provider_key: id,
          status: nullableString(provider.status) ?? "unknown",
          profile_count: Array.isArray(provider.profiles) ? provider.profiles.length : null,
          expires_at: typeof provider.expiresAt === "number" ? new Date(provider.expiresAt).toISOString() : null,
          secret_material_excluded: true,
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
    }

    const harnessRows = rows(agents, "agents").flatMap((agent): TelemetryRow[] => {
      const agentId = asString(agent.id);
      if (!agentId) return [];
      const runtime = asRecord(agent.agentRuntime);
      const runtimeId = asString(runtime.id) ?? "native";
      return [observedRow({
        row: {
          harness_key: stableKey(context.instanceKey, agentId, runtimeId),
          instance_key: context.instanceKey,
          agent_id: agentId,
          harness_id: runtimeId,
          source: nullableString(runtime.source),
          available: true,
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
    });

    const cfg = asRecord(context.cfg);
    const configuredAgents = Array.isArray(asRecord(cfg.agents).list) ? asRecord(cfg.agents).list as unknown[] : [];
    const acpRows = configuredAgents.flatMap((value): TelemetryRow[] => {
      const agent = asRecord(value);
      const id = asString(agent.id);
      const runtime = asRecord(agent.runtime);
      const acp = asRecord(runtime.acp);
      if (!id || asString(runtime.type) !== "acp") return [];
      const backend = asString(acp.backend) ?? "unknown";
      return [observedRow({
        row: {
          backend_key: stableKey(context.instanceKey, backend, id),
          instance_key: context.instanceKey,
          backend_id: backend,
          agent_id: id,
          harness_agent: nullableString(acp.agent),
          mode: nullableString(acp.mode),
          cwd: nullableString(acp.cwd),
          available: true,
          health_status: "configured",
          quota_supported: false,
          quota_limitation: "No supported Cursor/ACPX quota API is exposed by the installed build",
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
    });
    return {
      authority: "gateway_rpc:models.list+models.authStatus+agents.list",
      observedAt,
      writes: [
        write("models", "model_key", mappedModels),
        write("model_auth_status", "auth_key", authRows),
        write("agent_harnesses", "harness_key", harnessRows),
        write("acp_backends", "backend_key", acpRows),
      ],
    };
  },
};

export const toolsCollector: TelemetryCollector = {
  id: "tools",
  domain: "tools",
  intervalMs: 30 * MINUTE,
  maxIntervalMs: 2 * 60 * MINUTE,
  staleAfterMs: 60 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const [catalogValue, agentsValue] = await Promise.all([
      request(context, "tools.catalog"),
      request(context, "agents.list"),
    ]);
    const catalog = asRecord(catalogValue);
    const agents = rows(asRecord(agentsValue), "agents");
    const observedAt = context.now.toISOString();
    const tools = rows(catalog, "tools");
    const toolRows: TelemetryRow[] = [];
    const agentToolRows: TelemetryRow[] = [];
    for (const tool of tools) {
      const name = asString(tool.name);
      if (!name) continue;
      const pluginId = asString(tool.pluginId) ?? asString(tool.owner) ?? "core";
      const toolKey = stableKey(context.instanceKey, pluginId, name);
      toolRows.push(observedRow({
        row: {
          tool_key: toolKey,
          instance_key: context.instanceKey,
          tool_name: name,
          plugin_id: pluginId,
          display_name: nullableString(tool.displayName),
          description: nullableString(tool.description),
          risk: nullableString(tool.risk),
          available: tool.available === undefined ? true : asBoolean(tool.available, false),
          metadata: json({ tags: tool.tags ?? [] }),
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
      for (const agent of agents) {
        const agentId = asString(agent.id);
        if (!agentId) continue;
        agentToolRows.push(observedRow({
          row: {
            agent_tool_key: stableKey(context.instanceKey, agentId, toolKey),
            instance_key: context.instanceKey,
            agent_id: agentId,
            tool_key: toolKey,
            enabled: true,
            authority: "catalog-visible; effective policy may narrow at run time",
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
      }
    }
    return {
      authority: "gateway_rpc:tools.catalog",
      observedAt,
      writes: [write("tools", "tool_key", toolRows), write("agent_tools", "agent_tool_key", agentToolRows)],
    };
  },
};

export const skillsCollector: TelemetryCollector = {
  id: "skills",
  domain: "skills",
  intervalMs: 30 * MINUTE,
  maxIntervalMs: 2 * 60 * MINUTE,
  staleAfterMs: 60 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const agents = rows(asRecord(await request(context, "agents.list")), "agents");
    const observedAt = context.now.toISOString();
    const skillMap = new Map<string, TelemetryRow>();
    const agentSkillRows: TelemetryRow[] = [];
    for (const agent of agents) {
      const agentId = asString(agent.id);
      if (!agentId) continue;
      const status = asRecord(await request(context, "skills.status", { agentId }));
      for (const skill of rows(status, "skills")) {
        const name = asString(skill.name) ?? asString(skill.skillKey);
        if (!name) continue;
        const source = asString(skill.source) ?? "unknown";
        const skillKey = stableKey(context.instanceKey, source, name);
        skillMap.set(skillKey, observedRow({
          row: {
            skill_key: skillKey,
            instance_key: context.instanceKey,
            skill_name: name,
            source,
            bundled: asBoolean(skill.bundled, false),
            eligible: asBoolean(skill.eligible, false),
            disabled: asBoolean(skill.disabled, false),
            user_invocable: asBoolean(skill.userInvocable, false),
            command_visible: asBoolean(skill.commandVisible, false),
            file_path: nullableString(skill.filePath),
            requirements: json({
              bins: asRecord(skill.requirements).bins ?? [],
              config: asRecord(skill.requirements).config ?? [],
              os: asRecord(skill.requirements).os ?? [],
              environment_names_excluded: true,
            }),
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
        agentSkillRows.push(observedRow({
          row: {
            agent_skill_key: stableKey(context.instanceKey, agentId, skillKey),
            instance_key: context.instanceKey,
            agent_id: agentId,
            skill_key: skillKey,
            eligible: asBoolean(skill.eligible, false),
            enabled: !asBoolean(skill.disabled, false),
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
      }
    }
    return {
      authority: "gateway_rpc:skills.status",
      observedAt,
      writes: [
        write("skills", "skill_key", [...skillMap.values()]),
        write("agent_skills", "agent_skill_key", agentSkillRows),
      ],
    };
  },
};

export const executionPolicyCollector: TelemetryCollector = {
  id: "execution-policy",
  domain: "execution-policy",
  intervalMs: 30 * MINUTE,
  maxIntervalMs: 2 * 60 * MINUTE,
  staleAfterMs: 60 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const root = asRecord(context.cfg);
    const defaults = asRecord(asRecord(root.agents).defaults);
    const tools = asRecord(root.tools);
    const exec = asRecord(tools.exec);
    const sandbox = asRecord(root.sandbox);
    const observedAt = context.now.toISOString();
    const row = observedRow({
      row: {
        policy_key: stableKey(context.instanceKey, "global"),
        instance_key: context.instanceKey,
        scope_type: "global",
        scope_key: "global",
        sandbox_mode: nullableString(sandbox.mode),
        exec_host: nullableString(exec.host),
        exec_security: nullableString(exec.security),
        exec_ask: nullableString(exec.ask),
        default_workspace_path: nullableString(defaults.workspace),
        policy_metadata: json({
          allow_rule_count: Array.isArray(exec.allow) ? exec.allow.length : null,
          deny_rule_count: Array.isArray(exec.deny) ? exec.deny.length : null,
          rule_values_excluded: true,
        }),
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    });
    const pluginConfig = asRecord(asRecord(asRecord(root.plugins).entries).acpx);
    const mcpRoot = asRecord(asRecord(pluginConfig.config).mcpServers);
    const mcpRows = Object.keys(mcpRoot).map((name): TelemetryRow => observedRow({
      row: {
        server_key: stableKey(context.instanceKey, "acpx", name),
        instance_key: context.instanceKey,
        server_name: name,
        owner: "acpx",
        enabled: true,
        transport: "stdio",
        command_and_env_excluded: true,
        metadata: {},
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    }));
    return {
      authority: "plugin_api:config_snapshot",
      observedAt,
      writes: [write("execution_policies", "policy_key", [row]), write("mcp_servers", "server_key", mcpRows)],
    };
  },
};

export const capabilityCollectors: TelemetryCollector[] = [
  modelsCollector,
  toolsCollector,
  skillsCollector,
  executionPolicyCollector,
];
