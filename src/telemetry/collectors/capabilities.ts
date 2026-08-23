import { asBoolean, asRecord, asString } from "../../object-utils.js";
import { discoverInventory } from "../../inventory.js";
import type { TelemetryRow } from "../../types.js";
import { json, nullableString, observedRow, rows, stableKey, write } from "../collector-utils.js";
import { adaptiveStaleAfterMs } from "../freshness.js";
import { agentIdFromSessionKey, listAllSessionEntries, listConfiguredAgents, listConfiguredModelRefs } from "../public-runtime.js";
import type { CollectorContext, CollectorResult, TelemetryCollector } from "../types.js";

const MINUTE = 60_000;

async function request(context: CollectorContext, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return context.api.runtime.gateway.request(method, params);
}

export const modelsCollector: TelemetryCollector = {
  id: "models",
  domain: "models",
  intervalMs: 15 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(15 * MINUTE, 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const inventory = await discoverInventory(context.api, context.cfg);
    const availability = new Map(inventory.providers.map((provider) => [provider.providerKey, provider]));
    const mappedModels = listConfiguredModelRefs(context.cfg).flatMap((modelRef): TelemetryRow[] => {
      const separator = modelRef.indexOf("/");
      if (separator < 1) return [];
      const provider = modelRef.slice(0, separator);
      const id = modelRef.slice(separator + 1);
      return [observedRow({
        row: {
          model_key: stableKey(context.instanceKey, provider, id),
          instance_key: context.instanceKey,
          provider_key: provider,
          model_id: id,
          display_name: id,
          available: availability.get(provider)?.available === true,
          context_tokens: null,
          input_modalities: [],
          capabilities: { source: "configured_model_allowlist" },
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
    });
    const authRows = inventory.providers.map((provider): TelemetryRow => observedRow({
      row: {
        auth_key: stableKey(context.instanceKey, provider.providerKey),
        instance_key: context.instanceKey,
        provider_key: provider.providerKey,
        status: provider.available ? "available" : "unavailable",
        profile_count: null,
        expires_at: null,
        secret_material_excluded: true,
        metadata: provider.metadata,
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    }));

    const configuredAgents = listConfiguredAgents(context.api, context.cfg);
    const harnessRows = configuredAgents.map((agent): TelemetryRow => observedRow({
        row: {
          harness_key: stableKey(context.instanceKey, agent.id, agent.runtimeId),
          instance_key: context.instanceKey,
          agent_id: agent.id,
          harness_id: agent.runtimeId,
          source: agent.runtimeSource,
          available: true,
          metadata: { availability_source: "configured_agent" },
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));

    const acpRows = configuredAgents.flatMap((agent): TelemetryRow[] => {
      if (agent.runtimeId !== "acp") return [];
      const acp = asRecord(agent.runtimeConfig.acp);
      const backend = asString(acp.backend) ?? "unknown";
      return [observedRow({
        row: {
          backend_key: stableKey(context.instanceKey, backend, agent.id),
          instance_key: context.instanceKey,
          backend_id: backend,
          agent_id: agent.id,
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
      authority: "plugin_runtime:modelAuth+thinkingPolicy+config_snapshot",
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
  staleAfterMs: adaptiveStaleAfterMs(30 * MINUTE, 2 * 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const configuredAgents = listConfiguredAgents(context.api, context.cfg);
    const effectiveToolNames = new Map<string, Set<string>>();
    for (const session of listAllSessionEntries(context.api, context.cfg)) {
      const agentId = agentIdFromSessionKey(session.sessionKey);
      if (effectiveToolNames.has(agentId)) continue;
      const effective = asRecord(await request(context, "tools.effective", { agentId, sessionKey: session.sessionKey }));
      const names = new Set<string>();
      for (const group of Array.isArray(effective.groups) ? effective.groups.map(asRecord) : []) {
        for (const tool of Array.isArray(group.tools) ? group.tools.map(asRecord) : []) {
          const name = asString(tool.id) ?? asString(tool.name);
          if (name) names.add(name);
        }
      }
      effectiveToolNames.set(agentId, names);
    }
    const toolRows = new Map<string, TelemetryRow>();
    const agentToolRows: TelemetryRow[] = [];
    for (const agent of configuredAgents) {
      const catalog = asRecord(await request(context, "tools.catalog", { agentId: agent.id }));
      const effective = effectiveToolNames.get(agent.id);
      for (const group of Array.isArray(catalog.groups) ? catalog.groups.map(asRecord) : []) {
        const groupPluginId = asString(group.pluginId) ?? (asString(group.source) === "core" ? "core" : "plugin");
        for (const tool of Array.isArray(group.tools) ? group.tools.map(asRecord) : []) {
          const name = asString(tool.id) ?? asString(tool.name);
          if (!name) continue;
          const pluginId = asString(tool.pluginId) ?? groupPluginId;
          const toolKey = stableKey(context.instanceKey, pluginId, name);
          toolRows.set(toolKey, observedRow({
            row: {
              tool_key: toolKey,
              instance_key: context.instanceKey,
              tool_name: name,
              plugin_id: pluginId,
              display_name: nullableString(tool.label) ?? nullableString(tool.displayName),
              description: nullableString(tool.description),
              risk: nullableString(tool.risk),
              available: tool.optional === true ? false : true,
              metadata: json({ source: nullableString(tool.source) ?? nullableString(group.source), tags: tool.tags ?? [], default_profiles: tool.defaultProfiles ?? [] }),
            },
            observedAt,
            staleAfterMs: this.staleAfterMs,
            bootId: context.bootId,
          }));
          agentToolRows.push(observedRow({
            row: {
              agent_tool_key: stableKey(context.instanceKey, agent.id, toolKey),
              instance_key: context.instanceKey,
              agent_id: agent.id,
              tool_key: toolKey,
              enabled: effective ? effective.has(name) : true,
              authority: effective ? "gateway_rpc:tools.effective (latest session)" : "gateway_rpc:tools.catalog (no session to evaluate)",
            },
            observedAt,
            staleAfterMs: this.staleAfterMs,
            bootId: context.bootId,
          }));
        }
      }
    }
    return {
      authority: "gateway_rpc:tools.catalog+tools.effective",
      observedAt,
      writes: [write("tools", "tool_key", [...toolRows.values()]), write("agent_tools", "agent_tool_key", agentToolRows)],
    };
  },
};

export const skillsCollector: TelemetryCollector = {
  id: "skills",
  domain: "skills",
  intervalMs: 30 * MINUTE,
  maxIntervalMs: 2 * 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(30 * MINUTE, 2 * 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const skillMap = new Map<string, TelemetryRow>();
    const agentSkillRows: TelemetryRow[] = [];
    for (const agent of listConfiguredAgents(context.api, context.cfg)) {
      const status = asRecord(await request(context, "skills.status", { agentId: agent.id }));
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
            agent_skill_key: stableKey(context.instanceKey, agent.id, skillKey),
            instance_key: context.instanceKey,
            agent_id: agent.id,
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
      writes: [write("skills", "skill_key", [...skillMap.values()]), write("agent_skills", "agent_skill_key", agentSkillRows)],
    };
  },
};

export const executionPolicyCollector: TelemetryCollector = {
  id: "execution-policy",
  domain: "execution-policy",
  intervalMs: 30 * MINUTE,
  maxIntervalMs: 2 * 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(30 * MINUTE, 2 * 60 * MINUTE),
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
