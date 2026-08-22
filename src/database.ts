import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { asRecord, asString, errorMessage, toJson } from "./object-utils.js";
import type {
  BridgeEvent,
  BridgeRun,
  BridgeTask,
  BridgeTaskStatus,
  ExecutionTargetPlan,
  InventoryIds,
  InventorySnapshot,
  Json,
  OperationalEventInput,
  QuotaStatus,
  ResolvedExecutionConfig,
  TaskTargetRecord,
  TelemetryWrite,
  TerminalWriteInput,
} from "./types.js";

export interface StartRunInput {
  runId: string;
  task: BridgeTask;
  workerId: string;
  resolved: ResolvedExecutionConfig;
  configId: string | null;
  providerId: string | null;
  parentSessionKey: string;
  parentSessionId: string;
  target: ExecutionTargetPlan;
  metadata: Record<string, Json>;
}

export interface RealtimeTaskNotification {
  taskId: string;
  status: BridgeTaskStatus;
}

export type RealtimeHealth = "connected" | "disconnected" | "error";

export interface TaskSubscription {
  unsubscribe(): Promise<void>;
}

export interface BridgeDatabase {
  refreshInventory(snapshot: InventorySnapshot): Promise<InventoryIds>;
  listReconciliationTasks(now: Date): Promise<BridgeTask[]>;
  getLatestRunForTask(taskId: string): Promise<BridgeRun | null>;
  getTaskTarget(taskId: string): Promise<TaskTargetRecord | null>;
  claimTask(taskId: string, workerId: string, leaseSeconds: number): Promise<BridgeTask | null>;
  renewLease(taskId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  startRun(input: StartRunInput): Promise<BridgeRun>;
  failClaimedTask(taskId: string, workerId: string, error: string, reportText: string): Promise<boolean>;
  attachOpenClawIds(runId: string, openclawRunId: string | null, openclawTaskId?: string | null): Promise<void>;
  appendEvents(events: BridgeEvent[]): Promise<void>;
  writeTerminal(input: TerminalWriteInput): Promise<boolean>;
  upsertQuota(rows: QuotaStatus[]): Promise<void>;
  writeTelemetry(writes: TelemetryWrite[]): Promise<void>;
  appendOperationalEvents(events: OperationalEventInput[]): Promise<void>;
  recordOperationalError(input: {
    rollupKey: string;
    instanceKey: string;
    domain: string;
    errorCode: string;
    observedAt: string;
    summary: string;
    bootId: string;
  }): Promise<void>;
  subscribeTasks(
    onNotification: (notification: RealtimeTaskNotification) => void,
    onHealth: (health: RealtimeHealth, detail?: string) => void,
  ): Promise<TaskSubscription>;
  close(): Promise<void>;
}

export function buildStartRunRpcParams(input: StartRunInput): Record<string, unknown> {
  const selected = input.resolved.config;
  return {
    p_run_id: input.runId,
    p_task_id: input.task.id,
    p_worker_id: input.workerId,
    p_requested_config: input.resolved.requestedConfig,
    p_used_config: selected.configKey,
    p_fallback_used: input.resolved.fallbackUsed,
    p_fallback_reason: input.resolved.fallbackReason,
    p_config_id: input.configId,
    p_provider_id: input.providerId,
    p_provider_key: selected.providerKey,
    p_runtime: selected.runtime,
    p_agent: selected.agent,
    p_model: selected.model,
    p_effort: selected.effort,
    p_parent_session_key: input.parentSessionKey,
    p_parent_session_id: input.parentSessionId,
    p_requested_instance_key: input.target.requestedInstanceKey,
    p_actual_instance_key: input.target.instanceKey,
    p_requested_agent_id: input.target.requestedAgentId,
    p_actual_agent_id: input.target.agentId,
    p_session_policy: input.target.sessionPolicy,
    p_source_session_key: input.target.sourceSessionKey,
    p_source_session_id: input.target.sourceSessionId,
    p_actual_session_key: input.target.actualSessionKey,
    p_actual_session_id: input.target.actualSessionId,
    p_project_key: input.target.projectKey,
    p_project_path: input.target.projectPath,
    p_workspace_key: input.target.workspaceKey,
    p_workspace_path: input.target.workspacePath,
    p_worktree_key: input.target.worktreeKey,
    p_worktree_path: input.target.worktreePath,
    p_busy_policy: input.target.busyPolicy,
    p_metadata: input.metadata,
  };
}

function mapTaskTarget(value: unknown): TaskTargetRecord {
  const row = asRecord(value);
  const sessionPolicy = asString(row.session_policy);
  const busyPolicy = asString(row.busy_policy);
  return {
    taskId: String(row.task_id),
    instanceKey: asString(row.instance_key),
    agentId: asString(row.agent_id),
    sessionPolicy: sessionPolicy === "continue" || sessionPolicy === "fork" ? sessionPolicy : "new",
    sessionKey: asString(row.session_key),
    sessionId: asString(row.session_id),
    projectKey: asString(row.project_key),
    projectPath: asString(row.project_path),
    workspaceKey: asString(row.workspace_key),
    workspacePath: asString(row.workspace_path),
    worktreeKey: asString(row.worktree_key),
    worktreePath: asString(row.worktree_path),
    nodeKey: asString(row.node_key),
    nodeId: asString(row.node_id),
    busyPolicy: busyPolicy === "reject" ? "reject" : "queue",
    metadata: toJson(asRecord(row.metadata)) as Record<string, Json>,
  };
}

function unwrapRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return data.length ? asRecord(data[0]) : null;
  return Object.keys(asRecord(data)).length ? asRecord(data) : null;
}

function mapTask(value: unknown): BridgeTask {
  const row = asRecord(value);
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    prompt: String(row.prompt),
    requestedConfig: asString(row.requested_config),
    status: String(row.status) as BridgeTaskStatus,
    claimedBy: asString(row.claimed_by),
    claimedAt: asString(row.claimed_at),
    leaseExpiresAt: asString(row.lease_expires_at),
    metadata: toJson(asRecord(row.metadata)) as Record<string, Json>,
  };
}

function mapRun(value: unknown): BridgeRun {
  const row = asRecord(value);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    createdAt: String(row.created_at),
    startedAt: asString(row.started_at),
    finishedAt: asString(row.finished_at),
    status: String(row.status) as BridgeRun["status"],
    requestedConfig: asString(row.requested_config),
    usedConfig: String(row.used_config),
    fallbackUsed: Boolean(row.fallback_used),
    fallbackReason: asString(row.fallback_reason),
    configId: asString(row.config_id),
    providerId: asString(row.provider_id),
    providerKey: asString(row.provider_key),
    runtime: asString(row.runtime),
    agent: asString(row.agent),
    model: asString(row.model),
    effort: asString(row.effort),
    openclawTaskId: asString(row.openclaw_task_id),
    openclawRunId: asString(row.openclaw_run_id),
    parentSessionKey: asString(row.parent_session_key),
    parentSessionId: asString(row.parent_session_id),
    error: asString(row.error),
    metadata: toJson(asRecord(row.metadata)) as Record<string, Json>,
  };
}

function throwDatabaseError(context: string, error: unknown): never {
  throw new Error(`${context}: ${errorMessage(error)}`);
}

export class SupabaseBridgeDatabase implements BridgeDatabase {
  readonly #client: SupabaseClient;
  readonly #channels = new Set<RealtimeChannel>();

  constructor(url: string, credential: string) {
    this.#client = createClient(url, credential, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "X-Client-Info": "openclaw-supabase-bridge/0.2.0" } },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }

  async refreshInventory(snapshot: InventorySnapshot): Promise<InventoryIds> {
    const refreshedAt = new Date().toISOString();
    const providerPayload = snapshot.providers.map((provider) => ({
      provider_key: provider.providerKey,
      name: provider.name,
      available: provider.available,
      metadata: provider.metadata,
      updated_at: provider.updatedAt,
    }));
    const providerKeys = snapshot.providers.map((provider) => provider.providerKey);
    const configKeys = snapshot.configs.map((config) => config.configKey);
    const providerKeySet = new Set(providerKeys);
    const configKeySet = new Set(configKeys);
    const providerIds = new Map<string, string>();
    const configIds = new Map<string, string>();

    const currentProviders = await this.#client.from("providers").select("id,provider_key,available");
    if (currentProviders.error) throwDatabaseError("read current providers", currentProviders.error);
    for (const row of currentProviders.data ?? []) {
      if (providerKeySet.has(String(row.provider_key)) || row.available !== true) continue;
      const result = await this.#client
        .from("providers")
        .update({ available: false, updated_at: refreshedAt })
        .eq("id", String(row.id));
      if (result.error) throwDatabaseError("mark stale provider unavailable", result.error);
    }
    if (providerPayload.length) {
      const result = await this.#client.from("providers").upsert(providerPayload, { onConflict: "provider_key" });
      if (result.error) throwDatabaseError("upsert providers", result.error);
    }

    if (providerKeys.length) {
      const result = await this.#client.from("providers").select("id,provider_key").in("provider_key", providerKeys);
      if (result.error) throwDatabaseError("read provider ids", result.error);
      for (const row of result.data ?? []) providerIds.set(String(row.provider_key), String(row.id));
    }

    const currentConfigs = await this.#client.from("agent_configs").select("id,config_key,available,is_default");
    if (currentConfigs.error) throwDatabaseError("read current agent configs", currentConfigs.error);
    for (const row of currentConfigs.data ?? []) {
      const patch: Record<string, unknown> = {};
      if (row.is_default === true) patch.is_default = false;
      if (!configKeySet.has(String(row.config_key)) && row.available === true) patch.available = false;
      if (!Object.keys(patch).length) continue;
      patch.updated_at = refreshedAt;
      const result = await this.#client.from("agent_configs").update(patch).eq("id", String(row.id));
      if (result.error) throwDatabaseError("prepare agent config refresh", result.error);
    }

    const configPayload = snapshot.configs.map((config) => {
      const providerId = providerIds.get(config.providerKey);
      if (!providerId) throw new Error(`Inventory provider id missing for ${config.providerKey}`);
      return {
        config_key: config.configKey,
        provider_id: providerId,
        runtime: config.runtime,
        agent: config.agent,
        model: config.model,
        effort: config.effort,
        available: config.available,
        is_default: config.isDefault,
        other: config.other,
        updated_at: config.updatedAt,
      };
    });
    if (configPayload.length) {
      const result = await this.#client.from("agent_configs").upsert(configPayload, { onConflict: "config_key" });
      if (result.error) throwDatabaseError("upsert agent configs", result.error);
    }
    if (configKeys.length) {
      const result = await this.#client.from("agent_configs").select("id,config_key").in("config_key", configKeys);
      if (result.error) throwDatabaseError("read config ids", result.error);
      for (const row of result.data ?? []) configIds.set(String(row.config_key), String(row.id));
    }
    return { providerIds, configIds };
  }

  async listReconciliationTasks(now: Date): Promise<BridgeTask[]> {
    const { data, error } = await this.#client.rpc("list_bridge_reconciliation_tasks", {
      p_now: now.toISOString(),
    });
    if (error) throwDatabaseError("list reconciliation tasks", error);
    return (Array.isArray(data) ? data : []).map(mapTask);
  }

  async getLatestRunForTask(taskId: string): Promise<BridgeRun | null> {
    const { data, error } = await this.#client
      .from("runs")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throwDatabaseError("read latest run", error);
    return data ? mapRun(data) : null;
  }

  async getTaskTarget(taskId: string): Promise<TaskTargetRecord | null> {
    const { data, error } = await this.#client
      .from("task_targets")
      .select("*")
      .eq("task_id", taskId)
      .maybeSingle();
    if (error) throwDatabaseError("read task target", error);
    return data ? mapTaskTarget(data) : null;
  }

  async claimTask(taskId: string, workerId: string, leaseSeconds: number): Promise<BridgeTask | null> {
    const { data, error } = await this.#client.rpc("claim_bridge_task", {
      p_task_id: taskId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throwDatabaseError("claim task", error);
    const row = unwrapRow(data);
    return row ? mapTask(row) : null;
  }

  async renewLease(taskId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const { data, error } = await this.#client.rpc("renew_bridge_task_lease", {
      p_task_id: taskId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throwDatabaseError("renew task lease", error);
    return data === true;
  }

  async startRun(input: StartRunInput): Promise<BridgeRun> {
    const { data, error } = await this.#client.rpc("start_bridge_run_v2", buildStartRunRpcParams(input));
    if (error) throwDatabaseError("start bridge run", error);
    const row = unwrapRow(data);
    if (!row) throw new Error("start bridge run returned no row");
    return mapRun(row);
  }

  async failClaimedTask(taskId: string, workerId: string, errorText: string, reportText: string): Promise<boolean> {
    const { data, error } = await this.#client.rpc("fail_claimed_bridge_task", {
      p_task_id: taskId,
      p_worker_id: workerId,
      p_error: errorText,
      p_report_text: reportText,
    });
    if (error) throwDatabaseError("fail claimed task", error);
    return data === true;
  }

  async attachOpenClawIds(
    runId: string,
    openclawRunId: string | null,
    openclawTaskId: string | null = null,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (openclawRunId) patch.openclaw_run_id = openclawRunId;
    if (openclawTaskId) patch.openclaw_task_id = openclawTaskId;
    if (!Object.keys(patch).length) return;
    const { error } = await this.#client.from("runs").update(patch).eq("id", runId);
    if (error) throwDatabaseError("attach OpenClaw identifiers", error);
  }

  async appendEvents(events: BridgeEvent[]): Promise<void> {
    if (!events.length) return;
    const rows = events.map((event) => ({
      event_key: event.eventKey,
      task_id: event.taskId,
      run_id: event.runId,
      created_at: event.createdAt,
      event_ts: event.eventTs,
      source_run_id: event.sourceRunId,
      source_session_key: event.sourceSessionKey,
      source_session_id: event.sourceSessionId,
      source_agent_id: event.sourceAgentId,
      lifecycle_generation: event.lifecycleGeneration,
      seq: event.seq,
      stream: event.stream,
      event_type: event.eventType,
      data: event.data,
    }));
    const { error } = await this.#client.from("events").upsert(rows, {
      onConflict: "event_key",
      ignoreDuplicates: true,
    });
    if (error) throwDatabaseError("append agent events", error);
  }

  async writeTerminal(input: TerminalWriteInput): Promise<boolean> {
    const rpc = input.status === "completed" ? "complete_bridge_run" : "fail_bridge_run";
    const params = input.status === "completed"
      ? {
          p_run_id: input.runId,
          p_report_text: input.reportText,
          p_report: input.report,
          p_metadata: input.metadata,
          p_openclaw_run_id: input.openclawRunId,
          p_openclaw_task_id: input.openclawTaskId,
          p_actual_provider_key: input.actualProviderKey,
          p_actual_model: input.actualModel,
        }
      : {
          p_run_id: input.runId,
          p_status: input.status,
          p_error: input.error,
          p_report_text: input.reportText,
          p_report: input.report,
          p_metadata: input.metadata,
          p_openclaw_run_id: input.openclawRunId,
          p_openclaw_task_id: input.openclawTaskId,
          p_actual_provider_key: input.actualProviderKey,
          p_actual_model: input.actualModel,
        };
    const { data, error } = await this.#client.rpc(rpc, params);
    if (error) throwDatabaseError(`write ${input.status} terminal state`, error);
    return data === true;
  }

  async upsertQuota(rows: QuotaStatus[]): Promise<void> {
    if (!rows.length) return;
    const payload = rows.map((row) => ({
      quota_identity: row.quotaIdentity,
      provider_id: row.providerId,
      config_id: row.configId ?? null,
      account_key: row.accountKey,
      quota_key: row.quotaKey,
      remaining: row.remaining,
      limit_value: row.limitValue,
      unit: row.unit,
      reset_at: row.resetAt,
      checked_at: row.checkedAt,
      status: row.status,
      source: row.source,
      other: row.other,
    }));
    const { error } = await this.#client.from("quota_status").upsert(payload, {
      onConflict: "quota_identity",
    });
    if (error) throwDatabaseError("upsert quota status", error);
  }

  async writeTelemetry(writes: TelemetryWrite[]): Promise<void> {
    for (const batch of writes) {
      if (!batch.rows.length) continue;
      const payload = batch.rows.map((row) => Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== undefined),
      ));
      const { error } = await this.#client.from(batch.table).upsert(payload, {
        onConflict: batch.onConflict,
      });
      if (error) throwDatabaseError(`upsert telemetry ${batch.table}`, error);
    }
  }

  async appendOperationalEvents(events: OperationalEventInput[]): Promise<void> {
    if (!events.length) return;
    const payload = events.map((event) => ({
      event_key: event.eventKey,
      instance_key: event.instanceKey,
      boot_id: event.bootId,
      source: event.source,
      domain: event.domain,
      severity: event.severity,
      event_type: event.eventType,
      event_ts: event.eventTs,
      agent_id: event.agentId ?? null,
      session_key: event.sessionKey ?? null,
      session_id: event.sessionId ?? null,
      run_id: event.runId ?? null,
      bridge_task_id: event.taskId ?? null,
      summary: event.summary ?? null,
      data: event.data,
    }));
    const { error } = await this.#client.from("operational_events").upsert(payload, {
      onConflict: "event_key",
      ignoreDuplicates: true,
    });
    if (error) throwDatabaseError("append operational events", error);
  }

  async recordOperationalError(input: {
    rollupKey: string;
    instanceKey: string;
    domain: string;
    errorCode: string;
    observedAt: string;
    summary: string;
    bootId: string;
  }): Promise<void> {
    const { error } = await this.#client.rpc("record_bridge_error_rollup", {
      p_rollup_key: input.rollupKey,
      p_instance_key: input.instanceKey,
      p_domain: input.domain,
      p_error_code: input.errorCode,
      p_observed_at: input.observedAt,
      p_sample_summary: input.summary,
      p_boot_id: input.bootId,
    });
    if (error) throwDatabaseError("record operational error rollup", error);
  }

  async subscribeTasks(
    onNotification: (notification: RealtimeTaskNotification) => void,
    onHealth: (health: RealtimeHealth, detail?: string) => void,
  ): Promise<TaskSubscription> {
    const channel = this.#client
      .channel(`supabase-bridge-tasks-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        (payload) => {
          const row = asRecord(payload.new);
          const taskId = asString(row.id);
          const status = asString(row.status) as BridgeTaskStatus | null;
          if (taskId && status) onNotification({ taskId, status });
        },
      );

    this.#channels.add(channel);
    channel.subscribe((status, error) => {
      if (status === "SUBSCRIBED") onHealth("connected");
      else if (status === "CLOSED") onHealth("disconnected", "Realtime channel closed");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        onHealth("error", errorMessage(error ?? status));
      }
    });

    return {
      unsubscribe: async () => {
        this.#channels.delete(channel);
        await this.#client.removeChannel(channel);
      },
    };
  }

  async close(): Promise<void> {
    const channels = [...this.#channels];
    this.#channels.clear();
    await Promise.all(channels.map(async (channel) => this.#client.removeChannel(channel)));
  }
}

export function createSupabaseBridgeDatabase(url: string, credential: string): BridgeDatabase {
  return new SupabaseBridgeDatabase(url, credential);
}
