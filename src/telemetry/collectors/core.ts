import { arch, freemem, hostname, platform, release } from "node:os";
import { asBoolean, asRecord, asString } from "../../object-utils.js";
import { sessionEntryHasActiveRun } from "../../session-activity.js";
import type { TelemetryRow } from "../../types.js";
import { json, nullableString, observedRow, safeMetadata, stableHash, stableKey, write } from "../collector-utils.js";
import { adaptiveStaleAfterMs } from "../freshness.js";
import { agentIdFromSessionKey, listAllSessionEntries, listConfiguredAgents } from "../public-runtime.js";
import type { CollectorContext, CollectorResult, TelemetryCollector } from "../types.js";

const MINUTE = 60_000;

export const gatewayCollector: TelemetryCollector = {
  id: "gateway",
  domain: "gateway",
  intervalMs: MINUTE,
  activeIntervalMs: 15_000,
  maxIntervalMs: 5 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(MINUTE, 5 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const root = asRecord(context.cfg);
    const gatewayConfig = asRecord(root.gateway);
    const pluginEntries = asRecord(asRecord(root.plugins).entries);
    const enabledPluginCount = Object.values(pluginEntries)
      .map(asRecord)
      .filter((entry) => entry.enabled !== false).length;
    const observedAt = context.now.toISOString();
    const common = { observedAt, staleAfterMs: this.staleAfterMs, bootId: context.bootId };
    const instance = observedRow({
      ...common,
      row: {
        instance_key: context.instanceKey,
        display_name: hostname() || context.instanceKey,
        hostname: hostname() || null,
        platform: platform(),
        release: release(),
        arch: arch(),
        openclaw_version: context.api.runtime.version,
        node_version: process.version,
        gateway_port: typeof gatewayConfig.port === "number" ? gatewayConfig.port : null,
        gateway_pid: process.pid,
        status: "healthy",
      },
    });
    const gateway = observedRow({
      ...common,
      row: {
        instance_key: context.instanceKey,
        healthy: true,
        reachable: true,
        event_loop_degraded: false,
        config_reload_status: null,
        loaded_plugin_count: enabledPluginCount,
        plugin_error_count: null,
        heartbeat_seconds: null,
        uptime_ms: Math.round(process.uptime() * 1_000),
        last_error: null,
      },
    });
    const metric = observedRow({
      ...common,
      row: {
        sample_key: stableHash(context.instanceKey, context.bootId, Math.floor(context.now.getTime() / MINUTE)),
        instance_key: context.instanceKey,
        sampled_at: observedAt,
        event_loop_delay_p99_ms: null,
        event_loop_delay_max_ms: null,
        event_loop_utilization: null,
        cpu_core_ratio: null,
        memory_free_bytes: freemem(),
        disk_available_bytes: null,
      },
    });
    return {
      authority: "plugin_runtime:lifecycle+version+config_snapshot",
      observedAt,
      writes: [
        write("openclaw_instances", "instance_key", [instance]),
        write("gateway_status", "instance_key", [gateway]),
        write("gateway_metric_samples", "sample_key", [metric]),
      ],
    };
  },
};

export const agentsCollector: TelemetryCollector = {
  id: "agents",
  domain: "agents",
  intervalMs: 5 * MINUTE,
  maxIntervalMs: 30 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(5 * MINUTE, 30 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const configured = listConfiguredAgents(context.api, context.cfg);
    const agentRows = configured.map((agent): TelemetryRow => {
      return observedRow({
        row: {
          agent_key: stableKey(context.instanceKey, agent.id),
          instance_key: context.instanceKey,
          agent_id: agent.id,
          name: agent.name,
          is_default: agent.isDefault,
          available: true,
          workspace_path: agent.workspacePath || null,
          workspace_git: null,
          runtime_id: agent.runtimeId,
          runtime_source: agent.runtimeSource,
          primary_model_ref: agent.primaryModelRef,
          thinking_default: agent.thinkingDefault,
          capabilities: json({
            runtime_type: agent.runtimeId,
            acp_backend: asString(asRecord(agent.runtimeConfig.acp).backend),
            availability_source: "configured_agent",
          }),
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      });
    });
    const bindings = agentRows.map((agent): TelemetryRow => observedRow({
      row: {
        binding_key: stableKey(agent.agent_key as string, "workspace"),
        instance_key: context.instanceKey,
        agent_key: agent.agent_key,
        binding_type: "workspace",
        target_key: agent.workspace_path ?? null,
        enabled: true,
        metadata: {},
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    }));
    return {
      authority: "plugin_runtime:agent_resolvers+config_snapshot",
      observedAt,
      writes: [
        write("openclaw_agents", "agent_key", agentRows),
        write("agent_bindings", "binding_key", bindings),
      ],
    };
  },
};

export const sessionsCollector: TelemetryCollector = {
  id: "sessions",
  domain: "sessions",
  intervalMs: 2 * MINUTE,
  activeIntervalMs: 15_000,
  maxIntervalMs: 15 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(2 * MINUTE, 15 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const sessionRows: TelemetryRow[] = [];
    const relationRows: TelemetryRow[] = [];
    const activeRows: TelemetryRow[] = [];
    const configuredAgents = new Map(listConfiguredAgents(context.api, context.cfg).map((agent) => [agent.id, agent]));
    for (const summary of listAllSessionEntries(context.api, context.cfg)) {
      const key = asString(summary.sessionKey);
      const session = asRecord(summary.entry);
      const sessionId = asString(session.sessionId);
      if (!key || !sessionId) continue;
      const agentId = agentIdFromSessionKey(key);
      const configuredAgent = configuredAgents.get(agentId);
      const hasActiveRun = sessionEntryHasActiveRun(session);
      const archived = typeof session.archivedAt === "number";
      const pinned = typeof session.pinnedAt === "number";
      const lastReadAt = typeof session.lastReadAt === "number" ? session.lastReadAt : 0;
      const markedUnreadAt = typeof session.markedUnreadAt === "number" ? session.markedUnreadAt : 0;
      sessionRows.push(observedRow({
        row: {
          session_key: key,
          instance_key: context.instanceKey,
          session_id: sessionId,
          agent_key: stableKey(context.instanceKey, agentId),
          agent_id: agentId,
          kind: typeof session.spawnDepth === "number" && session.spawnDepth > 0 ? "subagent" : "direct",
          label: nullableString(session.label),
          display_name: nullableString(session.displayName),
          status: nullableString(session.status) ?? (hasActiveRun ? "running" : archived ? "archived" : "idle"),
          has_active_run: hasActiveRun,
          archived,
          pinned,
          unread: markedUnreadAt > lastReadAt,
          parent_session_key: nullableString(session.parentSessionKey) ?? nullableString(session.spawnedBy),
          runtime_id: nullableString(session.agentHarnessId) ?? configuredAgent?.runtimeId ?? null,
          model_provider: nullableString(session.modelProvider),
          model: nullableString(session.model),
          total_tokens: typeof session.totalTokens === "number" ? session.totalTokens : null,
          total_tokens_fresh: asBoolean(session.totalTokensFresh, false),
          started_at: typeof session.startedAt === "number" ? new Date(session.startedAt).toISOString()
            : typeof session.sessionStartedAt === "number" ? new Date(session.sessionStartedAt).toISOString() : null,
          ended_at: typeof session.endedAt === "number" ? new Date(session.endedAt).toISOString() : null,
          updated_at_source: typeof session.updatedAt === "number" ? new Date(session.updatedAt).toISOString() : observedAt,
          workspace_path: nullableString(session.spawnedWorkspaceDir),
          cwd: nullableString(session.spawnedCwd),
          metadata: safeMetadata({
            chat_type: session.chatType,
            channel: session.channel,
            last_channel: session.lastChannel,
            spawn_depth: session.spawnDepth,
            subagent_role: session.subagentRole,
            aborted_last_run: session.abortedLastRun,
            agent_harness_id: session.agentHarnessId,
          }),
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
      const parent = asString(session.parentSessionKey) ?? asString(session.spawnedBy);
      if (parent) relationRows.push(observedRow({
        row: {
          relation_key: stableKey(context.instanceKey, parent, key, "parent"),
          instance_key: context.instanceKey,
          parent_session_key: parent,
          child_session_key: key,
          relation_type: asString(session.spawnedBy) ? "spawned" : "forked",
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
      activeRows.push(observedRow({
        row: {
          active_run_key: stableKey(context.instanceKey, key),
          instance_key: context.instanceKey,
          session_key: key,
          session_id: sessionId,
          run_id: hasActiveRun ? nullableString(session.restartRecoveryDeliveryRunId) : null,
          status: hasActiveRun ? "running" : "idle",
          started_at: hasActiveRun
            ? (typeof session.startedAt === "number" ? new Date(session.startedAt).toISOString() : observedAt)
            : null,
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
    }
    return {
      authority: "plugin_runtime:agent.session.listSessionEntries",
      observedAt,
      activity: activeRows.some((row) => row.status === "running") ? "active" : "idle",
      writes: [
        write("openclaw_sessions", "session_key", sessionRows),
        write("session_relations", "relation_key", relationRows),
        write("session_active_runs", "active_run_key", activeRows),
      ],
    };
  },
};

export const tasksCollector: TelemetryCollector = {
  id: "tasks",
  domain: "tasks",
  intervalMs: MINUTE,
  activeIntervalMs: 10_000,
  maxIntervalMs: 10 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(MINUTE, 10 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const entries = listAllSessionEntries(context.api, context.cfg);
    const taskRows: TelemetryRow[] = [];
    const flowRows: TelemetryRow[] = [];
    const memberRows: TelemetryRow[] = [];
    for (const { sessionKey } of entries) {
      const runs = context.api.runtime.tasks.runs.bindSession({ sessionKey }).list();
      for (const task of runs) {
        taskRows.push(observedRow({
          row: {
            task_key: stableKey(context.instanceKey, task.id),
            instance_key: context.instanceKey,
            openclaw_task_id: task.id,
            runtime: task.runtime,
            source_id: task.sourceId ?? null,
            session_key: task.sessionKey,
            child_session_key: task.childSessionKey ?? null,
            flow_id: task.flowId ?? null,
            parent_task_id: task.parentTaskId ?? null,
            agent_id: task.agentId ?? null,
            run_id: task.runId ?? null,
            label: task.label ?? null,
            title: task.title,
            status: task.status,
            delivery_status: task.deliveryStatus,
            notify_policy: task.notifyPolicy,
            created_at_source: new Date(task.createdAt).toISOString(),
            started_at: task.startedAt ? new Date(task.startedAt).toISOString() : null,
            ended_at: task.endedAt ? new Date(task.endedAt).toISOString() : null,
            last_event_at: task.lastEventAt ? new Date(task.lastEventAt).toISOString() : null,
            error: task.error ?? null,
            progress_summary: task.progressSummary ?? null,
            terminal_summary: task.terminalSummary ?? null,
            terminal_outcome: task.terminalOutcome ?? null,
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
      }
      const flows = context.api.runtime.tasks.flows.bindSession({ sessionKey }).list();
      for (const flow of flows) {
        flowRows.push(observedRow({
          row: {
            flow_key: stableKey(context.instanceKey, flow.id),
            instance_key: context.instanceKey,
            flow_id: flow.id,
            owner_key: flow.ownerKey,
            session_key: sessionKey,
            status: flow.status,
            notify_policy: flow.notifyPolicy,
            goal: flow.goal,
            current_step: flow.currentStep ?? null,
            created_at_source: new Date(flow.createdAt).toISOString(),
            updated_at_source: new Date(flow.updatedAt).toISOString(),
            ended_at: flow.endedAt ? new Date(flow.endedAt).toISOString() : null,
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
      }
      for (const task of runs) {
        if (!task.flowId) continue;
        memberRows.push(observedRow({
          row: {
            member_key: stableKey(context.instanceKey, task.flowId, task.id),
            instance_key: context.instanceKey,
            flow_id: task.flowId,
            openclaw_task_id: task.id,
            parent_task_id: task.parentTaskId ?? null,
            status: task.status,
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
      }
    }
    return {
      authority: "plugin_runtime:tasks.runs+tasks.flows",
      observedAt,
      activity: taskRows.some((row) => row.status === "queued" || row.status === "running") ? "active" : "idle",
      writes: [
        write("openclaw_tasks", "task_key", taskRows),
        write("task_flows", "flow_key", flowRows),
        write("task_flow_members", "member_key", memberRows),
      ],
    };
  },
};

export const channelsCollector: TelemetryCollector = {
  id: "channels",
  domain: "channels",
  intervalMs: 2 * MINUTE,
  maxIntervalMs: 15 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(2 * MINUTE, 15 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const channelRoot = asRecord(asRecord(context.cfg).channels);
    const mapped: TelemetryRow[] = [];
    for (const [channelId, channelValue] of Object.entries(channelRoot)) {
      const channel = asRecord(channelValue);
      const accountsRoot = asRecord(channel.accounts);
      const accounts = Object.keys(accountsRoot).length
        ? Object.entries(accountsRoot)
        : [["default", channelValue] as const];
      for (const [accountId, accountValue] of accounts) {
        const account = asRecord(accountValue);
        const enabled = account.enabled !== false && channel.enabled !== false;
        const isBridgeAccount = channelId === "supabase-bridge";
        mapped.push(observedRow({
          row: {
            account_key: stableKey(context.instanceKey, channelId, accountId),
            instance_key: context.instanceKey,
            channel_id: channelId,
            account_id: accountId,
            enabled,
            configured: true,
            running: isBridgeAccount && enabled,
            connected: isBridgeAccount && enabled,
            restart_pending: false,
            reconnect_attempts: 0,
            last_connected_at: isBridgeAccount && enabled ? observedAt : null,
            last_inbound_at: null,
            last_outbound_at: null,
            last_error: null,
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
      }
    }
    return {
      authority: "plugin_runtime:active_bridge+config_snapshot",
      observedAt,
      writes: [write("channel_accounts", "account_key", mapped)],
    };
  },
};

export const pluginsCollector: TelemetryCollector = {
  id: "plugins",
  domain: "plugins",
  intervalMs: 10 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(10 * MINUTE, 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const entries = asRecord(asRecord(asRecord(context.cfg).plugins).entries);
    const pluginRows = Object.entries(entries).map(([id, value]): TelemetryRow => {
      const entry = asRecord(value);
      const isSelf = id === context.api.id;
      return observedRow({
        row: {
          plugin_key: stableKey(context.instanceKey, id),
          instance_key: context.instanceKey,
          plugin_id: id,
          name: isSelf ? context.api.name : id,
          version: isSelf ? context.api.version ?? null : null,
          status: isSelf ? "loaded" : "configured",
          enabled: entry.enabled !== false,
          origin: isSelf ? context.api.source : "config",
          capability_kinds: isSelf ? ["channel", "telemetry", "mailbox"] : [],
          metadata: isSelf ? { registration_mode: context.api.registrationMode } : {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      });
    });
    const hookNames = [
      "agent_event_subscription",
      "llm_output",
      "session_start",
      "session_end",
      "subagent_spawned",
      "subagent_ended",
      "after_tool_call",
      "agent_end",
      "cron_changed",
      "gateway_start",
      "gateway_stop",
    ];
    const hookRows = hookNames.map((hookName): TelemetryRow => observedRow({
      row: {
        hook_key: stableKey(context.instanceKey, "supabase-bridge", hookName),
        instance_key: context.instanceKey,
        plugin_id: "supabase-bridge",
        hook_name: hookName,
        registered: true,
        observation_only: true,
        metadata: {},
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    }));
    return {
      authority: "plugin_registration+config_snapshot",
      observedAt,
      writes: [
        write("openclaw_plugins", "plugin_key", pluginRows),
        write("plugin_hooks", "hook_key", hookRows),
      ],
    };
  },
};

export const gatewayConfigCollector: TelemetryCollector = {
  id: "gateway-config",
  domain: "configuration",
  intervalMs: 30 * MINUTE,
  maxIntervalMs: 2 * 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(30 * MINUTE, 2 * 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const root = asRecord(context.cfg);
    const agents = asRecord(root.agents);
    const defaults = asRecord(agents.defaults);
    const plugins = asRecord(asRecord(root.plugins).entries);
    const channels = asRecord(root.channels);
    const safeShape = {
      agent_ids: Array.isArray(agents.list) ? agents.list.map((value) => asString(asRecord(value).id)).filter(Boolean) : ["main"],
      plugin_ids: Object.keys(plugins).sort(),
      channel_ids: Object.keys(channels).sort(),
      model_refs: Object.keys(asRecord(defaults.models)).sort(),
      primary_model: asString(asRecord(defaults.model).primary),
    };
    const observedAt = context.now.toISOString();
    const row = observedRow({
      row: {
        instance_key: context.instanceKey,
        config_fingerprint: stableHash(JSON.stringify(safeShape)),
        safe_shape: safeShape,
        secret_values_excluded: true,
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    });
    return { authority: "plugin_api:config_snapshot", observedAt, writes: [write("gateway_config_state", "instance_key", [row])] };
  },
};

export const coreCollectors: TelemetryCollector[] = [
  gatewayCollector,
  agentsCollector,
  sessionsCollector,
  tasksCollector,
  channelsCollector,
  pluginsCollector,
  gatewayConfigCollector,
];
