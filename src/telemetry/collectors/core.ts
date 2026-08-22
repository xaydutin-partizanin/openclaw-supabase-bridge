import { asBoolean, asRecord, asString } from "../../object-utils.js";
import type { TelemetryRow } from "../../types.js";
import { json, nullableString, observedRow, rows, safeMetadata, stableHash, stableKey, write } from "../collector-utils.js";
import type { CollectorContext, CollectorResult, TelemetryCollector } from "../types.js";

const MINUTE = 60_000;

async function gatewayRequest(context: CollectorContext, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return context.api.runtime.gateway.request(method, params);
}

export const gatewayCollector: TelemetryCollector = {
  id: "gateway",
  domain: "gateway",
  intervalMs: MINUTE,
  activeIntervalMs: 15_000,
  maxIntervalMs: 5 * MINUTE,
  staleAfterMs: 3 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const [healthValue, infoValue] = await Promise.all([
      gatewayRequest(context, "health"),
      gatewayRequest(context, "system.info"),
    ]);
    const health = asRecord(healthValue);
    const info = asRecord(infoValue);
    const eventLoop = asRecord(health.eventLoop);
    const healthPlugins = asRecord(health.plugins);
    const loadedPlugins = Array.isArray(healthPlugins.loaded) ? healthPlugins.loaded : [];
    const pluginErrors = Array.isArray(healthPlugins.errors) ? healthPlugins.errors : [];
    const observedAt = context.now.toISOString();
    const common = { observedAt, staleAfterMs: this.staleAfterMs, bootId: context.bootId };
    const instance = observedRow({
      ...common,
      row: {
        instance_key: context.instanceKey,
        display_name: nullableString(info.machineName) ?? nullableString(info.hostname) ?? context.instanceKey,
        hostname: nullableString(info.hostname),
        platform: nullableString(info.platform),
        release: nullableString(info.release),
        arch: nullableString(info.arch),
        openclaw_version: context.api.runtime.version,
        node_version: nullableString(info.nodeVersion),
        gateway_port: typeof info.port === "number" ? info.port : null,
        gateway_pid: typeof info.pid === "number" ? info.pid : null,
        status: health.ok === true ? "healthy" : "degraded",
      },
    });
    const gateway = observedRow({
      ...common,
      row: {
        instance_key: context.instanceKey,
        healthy: health.ok === true,
        reachable: true,
        event_loop_degraded: asBoolean(eventLoop.degraded, false),
        config_reload_status: asString(asRecord(health.configReload).hotReloadStatus),
        loaded_plugin_count: loadedPlugins.length,
        plugin_error_count: pluginErrors.length,
        heartbeat_seconds: typeof health.heartbeatSeconds === "number" ? health.heartbeatSeconds : null,
        uptime_ms: typeof info.uptimeMs === "number" ? info.uptimeMs : null,
        last_error: null,
      },
    });
    const metric = observedRow({
      ...common,
      row: {
        sample_key: stableHash(context.instanceKey, context.bootId, Math.floor(context.now.getTime() / MINUTE)),
        instance_key: context.instanceKey,
        sampled_at: observedAt,
        event_loop_delay_p99_ms: typeof eventLoop.delayP99Ms === "number" ? eventLoop.delayP99Ms : null,
        event_loop_delay_max_ms: typeof eventLoop.delayMaxMs === "number" ? eventLoop.delayMaxMs : null,
        event_loop_utilization: typeof eventLoop.utilization === "number" ? eventLoop.utilization : null,
        cpu_core_ratio: typeof eventLoop.cpuCoreRatio === "number" ? eventLoop.cpuCoreRatio : null,
        memory_free_bytes: typeof info.memoryFreeBytes === "number" ? info.memoryFreeBytes : null,
        disk_available_bytes: typeof info.diskAvailableBytes === "number" ? info.diskAvailableBytes : null,
      },
    });
    return {
      authority: "gateway_rpc:health+system.info",
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
  staleAfterMs: 15 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const result = asRecord(await gatewayRequest(context, "agents.list"));
    const observedAt = context.now.toISOString();
    const agentRows = rows(result, "agents").map((agent): TelemetryRow => {
      const id = asString(agent.id) ?? "unknown";
      const runtime = asRecord(agent.agentRuntime);
      const model = asRecord(agent.model);
      return observedRow({
        row: {
          agent_key: stableKey(context.instanceKey, id),
          instance_key: context.instanceKey,
          agent_id: id,
          name: nullableString(agent.name),
          is_default: asString(result.defaultId) === id,
          available: true,
          workspace_path: nullableString(agent.workspace),
          workspace_git: asBoolean(agent.workspaceGit, false),
          runtime_id: nullableString(runtime.id),
          runtime_source: nullableString(runtime.source),
          primary_model_ref: nullableString(model.primary),
          thinking_default: nullableString(agent.thinkingDefault),
          capabilities: json({ thinking_levels: agent.thinkingOptions ?? [] }),
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
      authority: "gateway_rpc:agents.list",
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
  staleAfterMs: 5 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const result = asRecord(await gatewayRequest(context, "sessions.list", { limit: 500 }));
    const observedAt = context.now.toISOString();
    const sessionRows: TelemetryRow[] = [];
    const relationRows: TelemetryRow[] = [];
    const activeRows: TelemetryRow[] = [];
    for (const session of rows(result, "sessions")) {
      const key = asString(session.key);
      const sessionId = asString(session.sessionId);
      if (!key || !sessionId) continue;
      const agentId = asString(session.agentId) ?? /^agent:([^:]+):/.exec(key)?.[1] ?? "main";
      sessionRows.push(observedRow({
        row: {
          session_key: key,
          instance_key: context.instanceKey,
          session_id: sessionId,
          agent_key: stableKey(context.instanceKey, agentId),
          agent_id: agentId,
          kind: nullableString(session.kind),
          label: nullableString(session.label),
          display_name: nullableString(session.displayName),
          status: nullableString(session.status) ?? (asBoolean(session.hasActiveRun, false) ? "running" : "idle"),
          has_active_run: asBoolean(session.hasActiveRun, false),
          archived: asBoolean(session.archived, false),
          pinned: asBoolean(session.pinned, false),
          unread: asBoolean(session.unread, false),
          parent_session_key: nullableString(session.parentSessionKey) ?? nullableString(session.spawnedBy),
          runtime_id: nullableString(asRecord(session.agentRuntime).id),
          model_provider: nullableString(session.modelProvider),
          model: nullableString(session.model),
          total_tokens: typeof session.totalTokens === "number" ? session.totalTokens : null,
          total_tokens_fresh: asBoolean(session.totalTokensFresh, false),
          started_at: typeof session.startedAt === "number" ? new Date(session.startedAt).toISOString() : null,
          ended_at: typeof session.endedAt === "number" ? new Date(session.endedAt).toISOString() : null,
          updated_at_source: typeof session.updatedAt === "number" ? new Date(session.updatedAt).toISOString() : observedAt,
          workspace_path: nullableString(session.spawnedWorkspaceDir),
          cwd: nullableString(session.spawnedCwd),
          metadata: safeMetadata({
            chat_type: session.chatType,
            channel: session.channel,
            last_channel: session.lastChannel,
            subagent_run_state: session.subagentRunState,
            aborted_last_run: session.abortedLastRun,
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
          run_id: asBoolean(session.hasActiveRun, false) ? nullableString(session.runId) : null,
          status: asBoolean(session.hasActiveRun, false) ? "running" : "idle",
          started_at: asBoolean(session.hasActiveRun, false)
            ? (typeof session.startedAt === "number" ? new Date(session.startedAt).toISOString() : observedAt)
            : null,
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
    }
    return {
      authority: "gateway_rpc:sessions.list",
      observedAt,
      activity: activeRows.length ? "active" : "idle",
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
  staleAfterMs: 3 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const entries = context.api.runtime.agent.session.listSessionEntries();
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
  staleAfterMs: 5 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const result = asRecord(await gatewayRequest(context, "channels.status"));
    const observedAt = context.now.toISOString();
    const accountRoot = asRecord(result.channelAccounts);
    const mapped: TelemetryRow[] = [];
    for (const [channelId, value] of Object.entries(accountRoot)) {
      if (!Array.isArray(value)) continue;
      for (const accountValue of value) {
        const account = asRecord(accountValue);
        const accountId = asString(account.accountId) ?? "default";
        mapped.push(observedRow({
          row: {
            account_key: stableKey(context.instanceKey, channelId, accountId),
            instance_key: context.instanceKey,
            channel_id: channelId,
            account_id: accountId,
            enabled: asBoolean(account.enabled, false),
            configured: asBoolean(account.configured, false),
            running: asBoolean(account.running, false),
            connected: asBoolean(account.connected, false),
            restart_pending: asBoolean(account.restartPending, false),
            reconnect_attempts: typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : 0,
            last_connected_at: typeof account.lastConnectedAt === "number" ? new Date(account.lastConnectedAt).toISOString() : null,
            last_inbound_at: typeof account.lastInboundAt === "number" ? new Date(account.lastInboundAt).toISOString() : null,
            last_outbound_at: typeof account.lastOutboundAt === "number" ? new Date(account.lastOutboundAt).toISOString() : null,
            last_error: nullableString(account.lastError),
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        }));
      }
    }
    return { authority: "gateway_rpc:channels.status", observedAt, writes: [write("channel_accounts", "account_key", mapped)] };
  },
};

export const pluginsCollector: TelemetryCollector = {
  id: "plugins",
  domain: "plugins",
  intervalMs: 10 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: 30 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const health = asRecord(await gatewayRequest(context, "health"));
    const observedAt = context.now.toISOString();
    const pluginState = asRecord(health.plugins);
    const loaded: unknown[] = Array.isArray(pluginState.loaded) ? pluginState.loaded : [];
    const pluginRows = loaded.flatMap((value: unknown): TelemetryRow[] => {
      const id = asString(value);
      if (!id) return [];
      return [observedRow({
        row: {
          plugin_key: stableKey(context.instanceKey, id),
          instance_key: context.instanceKey,
          plugin_id: id,
          name: id === "supabase-bridge" ? "Supabase Control Plane Bridge" : id,
          version: id === "supabase-bridge" ? "0.2.0" : null,
          status: "loaded",
          enabled: true,
          origin: null,
          capability_kinds: [],
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
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
      authority: "gateway_rpc:health + plugin_registration",
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
  staleAfterMs: 60 * MINUTE,
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
