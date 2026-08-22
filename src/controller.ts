import { createHash, randomUUID } from "node:crypto";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { assertRunnableConfig } from "./config.js";
import {
  createSupabaseBridgeDatabase,
  type BridgeDatabase,
  type RealtimeHealth,
  type StartRunInput,
  type TaskSubscription,
} from "./database.js";
import { EventBuffer } from "./event-buffer.js";
import { buildBridgeEvent, EventCorrelator } from "./event-correlator.js";
import { discoverInventory } from "./inventory.js";
import { LifecycleResources } from "./lifecycle-resources.js";
import {
  MemoryIngressQueue,
  TaskNotificationCoordinator,
  type IngressQueueLike,
} from "./notification-coordinator.js";
import { errorMessage, toJson } from "./object-utils.js";
import { QuotaCollector } from "./quota.js";
import { resolveTargetedExecutionConfig } from "./config-resolution.js";
import { sanitizeEventData } from "./sanitizer.js";
import { resolveExecutionTarget } from "./task-targeting.js";
import { capabilityCollectors } from "./telemetry/collectors/capabilities.js";
import { coreCollectors } from "./telemetry/collectors/core.js";
import { operationCollectors } from "./telemetry/collectors/operations.js";
import { TelemetryManager } from "./telemetry/manager.js";
import { TerminalWriter } from "./terminal-writer.js";
import type {
  AgentConfigRecord,
  BridgeEvent,
  BridgeRun,
  BridgeTask,
  InventoryIds,
  InventorySnapshot,
  Json,
  OpenClawAgentEvent,
  PluginConfig,
  ExecutionTargetPlan,
  TerminalWriteInput,
} from "./types.js";

export interface BridgeLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

interface ActiveRun {
  taskId: string;
  bridgeRunId: string;
  sessionKey: string;
  sourceRunId: string | null;
}

interface TaskPayload {
  taskId: string;
}

const INVENTORY_STALE_MS = 5 * 60_000;
const RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

function manualEvent(input: {
  taskId: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
  maxPayloadBytes: number;
}): BridgeEvent {
  const now = new Date().toISOString();
  const identity = `${input.runId}|bridge|${input.type}|${JSON.stringify(input.data)}`;
  return {
    eventKey: createHash("sha256").update(identity).digest("hex"),
    taskId: input.taskId,
    runId: input.runId,
    createdAt: now,
    eventTs: now,
    sourceRunId: null,
    sourceSessionKey: null,
    sourceSessionId: null,
    sourceAgentId: null,
    lifecycleGeneration: null,
    seq: null,
    stream: "bridge",
    eventType: input.type,
    data: sanitizeEventData(input.data, input.maxPayloadBytes).value,
  };
}

function extractReportText(result: Awaited<ReturnType<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]>>): string {
  const preferred = result.meta.finalAssistantVisibleText?.trim();
  if (preferred) return preferred;
  const visiblePayloads = (result.payloads ?? [])
    .filter((payload) => !payload.isReasoning && !payload.isCommentary && payload.text?.trim())
    .map((payload) => payload.text!.trim());
  if (visiblePayloads.length) return visiblePayloads.at(-1)!;
  const raw = result.meta.finalAssistantRawText?.trim();
  if (raw) return raw;
  return "OpenClaw finished without a visible assistant report.";
}

function terminalStatus(
  result: Awaited<ReturnType<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]>>,
): TerminalWriteInput["status"] {
  if (result.meta.aborted) return result.meta.timeoutPhase ? "timed_out" : "cancelled";
  if (result.meta.error || result.meta.failureSignal || result.payloads?.some((payload) => payload.isError)) return "failed";
  return "completed";
}

function terminalError(
  result: Awaited<ReturnType<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]>>,
): string | null {
  return result.meta.error?.message ?? result.meta.failureSignal?.message ?? null;
}

export class BridgeController {
  readonly #api: OpenClawPluginApi;
  readonly #cfg: OpenClawConfig;
  readonly #accountId: string;
  readonly #config: PluginConfig;
  readonly #logger: BridgeLogger;
  readonly #databaseFactory: (url: string, credential: string) => BridgeDatabase;
  readonly #resources = new LifecycleResources();
  readonly #correlator = new EventCorrelator();
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #attachedOpenClawIds = new Set<string>();
  #database: BridgeDatabase | null = null;
  #eventBuffer: EventBuffer | null = null;
  #terminalWriter: TerminalWriter | null = null;
  #telemetry: TelemetryManager | null = null;
  #coordinator: TaskNotificationCoordinator<TaskPayload> | null = null;
  #inventory: InventorySnapshot | null = null;
  #inventoryIds: InventoryIds = { providerIds: new Map(), configIds: new Map() };
  #inventoryRefreshedAt = 0;
  #subscription: TaskSubscription | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #started = false;
  #stopped = false;

  constructor(input: {
    api: OpenClawPluginApi;
    cfg: OpenClawConfig;
    accountId: string;
    config: PluginConfig;
    logger: BridgeLogger;
    databaseFactory?: (url: string, credential: string) => BridgeDatabase;
  }) {
    this.#api = input.api;
    this.#cfg = input.cfg;
    this.#accountId = input.accountId;
    this.#config = input.config;
    this.#logger = input.logger;
    this.#databaseFactory = input.databaseFactory ?? createSupabaseBridgeDatabase;
  }

  get started(): boolean {
    return this.#started && !this.#stopped;
  }

  async start(abortSignal?: AbortSignal): Promise<void> {
    if (this.started) return;
    assertRunnableConfig(this.#config);
    this.#stopped = false;
    this.#database = this.#databaseFactory(this.#config.supabaseUrl, this.#config.supabaseCredential);
    this.#eventBuffer = new EventBuffer(this.#database, {
      onError: (error) => this.#logger.error("Supabase Bridge event write failure", { error: errorMessage(error) }),
    });
    this.#terminalWriter = new TerminalWriter(this.#database);
    this.#resources.add(async () => this.#database?.close());
    this.#resources.add(async () => this.#eventBuffer?.stop());

    let runtimeQueue: IngressQueueLike<TaskPayload>;
    try {
      runtimeQueue = this.#api.runtime.state.openChannelIngressQueue<TaskPayload>({
        accountId: this.#accountId,
      }) as unknown as IngressQueueLike<TaskPayload>;
    } catch (error) {
      this.#logger.warn("OpenClaw durable ingress queue unavailable; using Supabase-durable notification fallback", {
        error: errorMessage(error),
      });
      runtimeQueue = new MemoryIngressQueue<TaskPayload>();
    }
    this.#coordinator = new TaskNotificationCoordinator({
      queue: runtimeQueue,
      ownerId: this.#config.workerId,
      process: async (payload) => this.#processTask(payload.taskId),
    });
    this.#resources.add(async () => this.#coordinator?.stop());
    this.#resources.add(async () => this.#unsubscribeRealtime());
    await this.#coordinator.start();
    await this.#refreshInventory(true);
    await this.#refreshQuota("startup");
    if (this.#config.telemetryEnabled) {
      this.#telemetry = new TelemetryManager({
        api: this.#api,
        cfg: this.#cfg,
        sink: this.#database,
        logger: this.#logger,
        instanceKey: this.#config.instanceKey,
        workerId: this.#config.workerId,
        heartbeatSeconds: this.#config.telemetryHeartbeatSeconds,
        collectors: [...coreCollectors, ...capabilityCollectors, ...operationCollectors],
      });
      this.#resources.add(async () => this.#telemetry?.stop());
      await this.#telemetry.start();
    }
    await this.#reconcile();
    await this.#subscribeRealtime();

    const quotaTimer = setInterval(
      () => void this.#refreshQuota("periodic"),
      this.#config.quotaRefreshIntervalMinutes * 60_000,
    );
    this.#resources.addTimer(quotaTimer);
    const reconciliationTimer = setInterval(() => void this.#reconcile(), RECONCILIATION_INTERVAL_MS);
    this.#resources.addTimer(reconciliationTimer);
    if (abortSignal) {
      const onAbort = () => void this.stop();
      abortSignal.addEventListener("abort", onAbort, { once: true });
      this.#resources.add(() => abortSignal.removeEventListener("abort", onAbort));
    }
    this.#started = true;
    this.#logger.info("Supabase Bridge started", { accountId: this.#accountId, workerId: this.#config.workerId });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    try {
      await this.#refreshQuota("shutdown");
    } catch (error) {
      this.#logger.warn("Supabase Bridge shutdown quota refresh failed", { error: errorMessage(error) });
    }
    try {
      await this.#resources.stop();
    } catch (error) {
      this.#logger.warn("Supabase Bridge cleanup completed with errors", { error: errorMessage(error) });
    }
    this.#logger.info("Supabase Bridge stopped", { accountId: this.#accountId });
  }

  async handleAgentEvent(event: OpenClawAgentEvent): Promise<void> {
    try {
      await this.#telemetry?.handleAgentEvent(event);
    } catch (error) {
      this.#logger.warn("Supabase Bridge operational telemetry event write failed", { error: errorMessage(error) });
    }
    if (!this.#config.eventLoggingEnabled || !this.#eventBuffer || !this.#database) return;
    const correlated = this.#correlator.correlate(event);
    if (!correlated) return;
    const active = [...this.#activeRuns.values()].find((run) => run.bridgeRunId === correlated.bridgeRunId);
    if (active) active.sourceRunId = event.runId;
    if (!this.#attachedOpenClawIds.has(correlated.bridgeRunId)) {
      this.#attachedOpenClawIds.add(correlated.bridgeRunId);
      try {
        await this.#database.attachOpenClawIds(correlated.bridgeRunId, event.runId);
      } catch (error) {
        this.#attachedOpenClawIds.delete(correlated.bridgeRunId);
        this.#logger.warn("Supabase Bridge could not attach OpenClaw run id", { error: errorMessage(error) });
      }
    }
    const bridgeEvent = buildBridgeEvent(correlated, this.#config.eventMaxPayloadBytes);
    if (bridgeEvent) this.#eventBuffer.append(bridgeEvent);
  }

  async handleHook(name: string, event: unknown, context?: unknown): Promise<void> {
    try {
      await this.#telemetry?.handleHook(name, event, context);
    } catch (error) {
      this.#logger.warn("Supabase Bridge operational hook telemetry write failed", { hook: name, error: errorMessage(error) });
    }
  }

  async requestCancellation(taskId: string): Promise<void> {
    const active = this.#activeRuns.get(taskId);
    if (!active) return;
    try {
      await this.#api.runtime.gateway.request("chat.abort", {
        sessionKey: active.sessionKey,
        ...(active.sourceRunId ? { runId: active.sourceRunId } : {}),
      });
    } catch (error) {
      this.#logger.warn("Supabase Bridge cancellation request could not abort active OpenClaw run", {
        taskId,
        error: errorMessage(error),
      });
    }
  }

  async recordOutbound(target: string, text: string): Promise<string> {
    const active = this.#activeRuns.get(target);
    if (active && this.#eventBuffer) {
      this.#eventBuffer.append(manualEvent({
        taskId: active.taskId,
        runId: active.bridgeRunId,
        type: "outbound_text",
        data: { text },
        maxPayloadBytes: this.#config.eventMaxPayloadBytes,
      }));
    }
    return `supabase-bridge:${randomUUID()}`;
  }

  async #refreshInventory(force = false): Promise<void> {
    if (!this.#database) return;
    if (!force && Date.now() - this.#inventoryRefreshedAt < INVENTORY_STALE_MS) return;
    const snapshot = await discoverInventory(this.#api, this.#cfg);
    const ids = await this.#database.refreshInventory(snapshot);
    for (const config of snapshot.configs) {
      const configId = ids.configIds.get(config.configKey);
      const providerId = ids.providerIds.get(config.providerKey);
      if (configId) config.id = configId;
      if (providerId) config.providerId = providerId;
    }
    for (const provider of snapshot.providers) {
      const providerId = ids.providerIds.get(provider.providerKey);
      if (providerId) provider.id = providerId;
    }
    this.#inventory = snapshot;
    this.#inventoryIds = ids;
    this.#inventoryRefreshedAt = Date.now();
    this.#logger.info("Supabase Bridge provider/config inventory refreshed", {
      providers: snapshot.providers.length,
      configs: snapshot.configs.length,
    });
  }

  async #refreshQuota(reason: string): Promise<void> {
    if (!this.#database || !this.#inventory) return;
    this.#logger.debug?.("Supabase Bridge quota refresh started", { reason });
    try {
      const rows = await new QuotaCollector(this.#api, this.#cfg).collect(this.#inventory, this.#inventoryIds);
      await this.#database.upsertQuota(rows);
      this.#logger.info("Supabase Bridge quota refresh completed", { reason, buckets: rows.length });
    } catch (error) {
      this.#logger.warn("Supabase Bridge quota refresh failed", { reason, error: errorMessage(error) });
    }
  }

  async #reconcile(): Promise<void> {
    if (!this.#database || !this.#coordinator || this.#stopped) return;
    try {
      const tasks = await this.#database.listReconciliationTasks(new Date());
      const enqueue: TaskPayload[] = [];
      for (const task of tasks) {
        if (task.status === "pending" || task.status === "claimed") {
          enqueue.push({ taskId: task.id });
          continue;
        }
        if (task.status === "running") {
          const run = await this.#database.getLatestRunForTask(task.id);
          if (run?.status === "running") {
            const taskState = run.parentSessionKey
              ? this.#api.runtime.tasks.runs.bindSession({ sessionKey: run.parentSessionKey }).findLatest()
              : undefined;
            await this.#terminalWriter?.write({
              taskId: task.id,
              runId: run.id,
              status: "failed",
              reportText: "OpenClaw restarted while this bridge run was active. The prior run could not be proven terminal, so it was not rerun automatically.",
              report: {
                summary: "Ambiguous interrupted bridge run",
                recovery: "marked_failed_without_rerun",
                openclaw_task_state: toJson(taskState ?? null),
              },
              error: "ambiguous_gateway_restart",
              metadata: { recovery_decision: "do_not_rerun_ambiguous_active_work" },
              openclawRunId: run.openclawRunId,
              openclawTaskId: run.openclawTaskId,
              actualProviderKey: run.providerKey,
              actualModel: run.model,
            });
          } else {
            await this.#database.failClaimedTask(
              task.id,
              this.#config.workerId,
              "ambiguous_gateway_restart_without_run",
              "OpenClaw found an expired running task without a recoverable run record and did not rerun it.",
            );
          }
        }
      }
      await this.#coordinator.reconcile(enqueue);
      this.#logger.info("Supabase Bridge reconciliation performed", { inspected: tasks.length, enqueued: enqueue.length });
    } catch (error) {
      this.#logger.warn("Supabase Bridge reconciliation failed", { error: errorMessage(error) });
    }
  }

  async #subscribeRealtime(): Promise<void> {
    if (!this.#database || this.#stopped) return;
    await this.#unsubscribeRealtime();
    this.#subscription = await this.#database.subscribeTasks(
      (notification) => {
        this.#logger.debug?.("Supabase Bridge task notification received", {
          taskId: notification.taskId,
          status: notification.status,
        });
        if (notification.status === "pending") void this.#coordinator?.notify({ taskId: notification.taskId });
        if (notification.status === "cancelled") void this.requestCancellation(notification.taskId);
      },
      (health, detail) => this.#handleRealtimeHealth(health, detail),
    );
  }

  #handleRealtimeHealth(health: RealtimeHealth, detail?: string): void {
    this.#telemetry?.setRealtimeState(health === "connected" ? "connected" : health, detail);
    if (health === "connected") {
      const reconnected = this.#reconnectAttempt > 0;
      this.#reconnectAttempt = 0;
      this.#logger.info(reconnected ? "Supabase Realtime reconnected" : "Supabase connected");
      if (reconnected) void this.#reconcile();
      return;
    }
    this.#logger.warn(health === "disconnected" ? "Supabase disconnected" : "Supabase Realtime error", { detail });
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(this.#reconnectAttempt, 6));
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void (async () => {
        try {
          await this.#subscribeRealtime();
          await this.#reconcile();
        } catch (error) {
          this.#logger.warn("Supabase Realtime reconnect failed", { error: errorMessage(error) });
          this.#scheduleReconnect();
        }
      })();
    }, delay);
  }

  async #unsubscribeRealtime(): Promise<void> {
    const subscription = this.#subscription;
    this.#subscription = null;
    if (subscription) await subscription.unsubscribe();
  }

  async #processTask(taskId: string): Promise<void> {
    if (!this.#database || !this.#terminalWriter || !this.#inventory) throw new Error("Bridge is not initialized");
    const claimed = await this.#database.claimTask(taskId, this.#config.workerId, this.#config.leaseDurationSeconds);
    if (!claimed) {
      this.#logger.debug?.("Supabase Bridge task claim failed or duplicate", { taskId });
      return;
    }
    this.#logger.info("Supabase Bridge task claim succeeded", { taskId });
    this.#telemetry?.noteOperation("claim");

    try {
      await this.#refreshInventory(false);
      const target = await this.#database.getTaskTarget(claimed.id);
      const resolved = resolveTargetedExecutionConfig(claimed.requestedConfig, target?.agentId, this.#inventory!.configs);
      const defaultWorkspace = this.#api.runtime.agent.resolveAgentWorkspaceDir(this.#cfg, resolved.config.agent);
      const executionTarget = await resolveExecutionTarget({
        gateway: this.#api.runtime.gateway,
        target,
        taskId: claimed.id,
        instanceKey: this.#config.instanceKey,
        selected: resolved.config,
        defaultWorkspace,
      });
      await this.#runClaimedTask(claimed, resolved.config, resolved, executionTarget);
    } catch (error) {
      const message = errorMessage(error);
      this.#logger.error("Supabase Bridge could not start claimed task", { taskId, error: message });
      await this.#database.failClaimedTask(
        claimed.id,
        this.#config.workerId,
        message,
        `The bridge could not start this task: ${message}`,
      );
    }
  }

  async #runClaimedTask(
    task: BridgeTask,
    selected: AgentConfigRecord,
    resolved: ReturnType<typeof resolveTargetedExecutionConfig>,
    target: ExecutionTargetPlan,
  ): Promise<void> {
    if (!this.#database || !this.#terminalWriter || !this.#eventBuffer) throw new Error("Bridge is not initialized");
    const runId = randomUUID();
    const sessionId = target.actualSessionId;
    const sessionKey = target.actualSessionKey;
    const startInput: StartRunInput = {
      runId,
      task,
      workerId: this.#config.workerId,
      resolved,
      configId: this.#inventoryIds.configIds.get(selected.configKey) ?? null,
      providerId: this.#inventoryIds.providerIds.get(selected.providerKey) ?? null,
      parentSessionKey: sessionKey,
      parentSessionId: sessionId,
      target,
      metadata: {
        inventory_refreshed_at: this.#inventory?.refreshedAt ?? null,
        direct_routing: true,
        legacy_targeting: target.legacy,
        session_policy: target.sessionPolicy,
        source_session_key: target.sourceSessionKey,
        source_session_id: target.sourceSessionId,
        workspace_path: target.workspacePath,
        worktree_path: target.worktreePath,
        queued_for_busy_session: target.queuedForBusySession,
      },
    };
    const run = await this.#database.startRun(startInput);
    this.#logger.info("Supabase Bridge run started", { taskId: task.id, runId, usedConfig: selected.configKey });
    this.#correlator.registerParent({ taskId: task.id, bridgeRunId: runId, sessionKey, sessionId });
    const active: ActiveRun = { taskId: task.id, bridgeRunId: runId, sessionKey, sourceRunId: null };
    this.#activeRuns.set(task.id, active);
    this.#eventBuffer.append(manualEvent({
      taskId: task.id,
      runId,
      type: "run_started",
      data: {
        requested_config: resolved.requestedConfig,
        used_config: selected.configKey,
        fallback_used: resolved.fallbackUsed,
        fallback_reason: resolved.fallbackReason,
        session_policy: target.sessionPolicy,
        requested_session_key: target.sourceSessionKey,
        actual_session_key: target.actualSessionKey,
        actual_agent_id: target.agentId,
        requested_instance_key: target.requestedInstanceKey,
        requested_agent_id: target.requestedAgentId,
        node_key: target.nodeKey,
        node_id: target.nodeId,
        cwd: target.cwd,
      },
      maxPayloadBytes: this.#config.eventMaxPayloadBytes,
    }));

    const leaseTimer = setInterval(() => {
      void this.#database?.renewLease(task.id, this.#config.workerId, this.#config.leaseDurationSeconds).catch((error: unknown) => {
        this.#logger.warn("Supabase Bridge lease renewal failed", { taskId: task.id, error: errorMessage(error) });
      });
    }, Math.max(20_000, Math.floor((this.#config.leaseDurationSeconds * 1_000) / 3)));

    try {
      const workspaceDir = this.#api.runtime.agent.resolveAgentWorkspaceDir(this.#cfg, selected.agent);
      const params: Parameters<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]>[0] = {
        runId,
        sessionId,
        sessionKey,
        sessionTarget: { agentId: selected.agent, sessionId, sessionKey },
        agentId: selected.agent,
        workspaceDir,
        cwd: target.cwd,
        prompt: task.prompt,
        trigger: "user",
        messageChannel: "supabase-bridge",
        messageProvider: "supabase-bridge",
        messageTo: task.id,
        currentMessagingTarget: task.id,
        chatType: "direct",
        senderId: "supabase-chatgpt",
        senderName: "ChatGPT via Supabase",
        senderIsOwner: true,
        disableMessageTool: true,
        allowGatewaySubagentBinding: true,
        config: this.#cfg,
        timeoutMs: this.#api.runtime.agent.resolveAgentTimeoutMs({ cfg: this.#cfg }),
      };
      if (selected.runtime === "native") {
        params.provider = selected.providerKey;
        if (selected.model) params.model = selected.model;
        const thinking = this.#api.runtime.agent.normalizeThinkingLevel(selected.effort);
        if (thinking) params.thinkLevel = thinking;
      }

      const result = await this.#api.runtime.agent.runEmbeddedAgent(params);
      const status = terminalStatus(result);
      const reportText = extractReportText(result);
      const sourceRunId = this.#correlator.sourceRunIdForBridgeRun(runId);
      const isAcp = selected.runtime === "acp";
      const actualProvider = isAcp ? null : (result.meta.agentMeta?.provider ?? selected.providerKey);
      const actualModel = isAcp ? null : (result.meta.agentMeta?.model ?? selected.model);
      const error = terminalError(result);
      const metadata = toJson({
        duration_ms: result.meta.durationMs,
        usage: result.meta.agentMeta?.usage,
        tool_summary: result.meta.toolSummary,
        completion: result.meta.completion,
        accepted_session_spawns: result.acceptedSessionSpawns,
        fallback_attempts: result.meta.agentMeta?.fallbackAttempts,
        openclaw_reported_runtime: isAcp
          ? {
              provider: result.meta.agentMeta?.provider,
              model: result.meta.agentMeta?.model,
              authoritative: false,
              reason: "ACP harness controls its internal model selection",
            }
          : null,
      }) as Record<string, Json>;
      this.#eventBuffer.append(manualEvent({
        taskId: task.id,
        runId,
        type: `run_${status}`,
        data: { status, error, duration_ms: result.meta.durationMs },
        maxPayloadBytes: this.#config.eventMaxPayloadBytes,
      }));
      await this.#eventBuffer.flush();
      this.#telemetry?.noteOperation("event_flush");
      await this.#terminalWriter.write({
        taskId: task.id,
        runId,
        status,
        reportText,
        report: {
          summary: reportText,
          status,
          used_config: selected.configKey,
          actual_session_key: target.actualSessionKey,
          actual_session_id: target.actualSessionId,
          actual_agent_id: target.agentId,
          session_policy: target.sessionPolicy,
        },
        error,
        metadata,
        openclawRunId: sourceRunId,
        openclawTaskId: null,
        actualProviderKey: actualProvider,
        actualModel,
      });
      this.#telemetry?.noteOperation("report");
      this.#logger.info(status === "completed" ? "Supabase Bridge run completed" : "Supabase Bridge run failed", {
        taskId: task.id,
        runId,
        status,
      });
    } catch (error) {
      const message = errorMessage(error);
      const sourceRunId = this.#correlator.sourceRunIdForBridgeRun(runId);
      await this.#terminalWriter.write({
        taskId: task.id,
        runId,
        status: "failed",
        reportText: `OpenClaw failed before producing a final report: ${message}`,
        report: { summary: "OpenClaw execution failed", error: message },
        error: message,
        metadata: { execution_exception: true },
        openclawRunId: sourceRunId,
        openclawTaskId: null,
        actualProviderKey: selected.runtime === "acp" ? null : selected.providerKey,
        actualModel: selected.runtime === "acp" ? null : selected.model,
      });
      this.#telemetry?.noteOperation("report");
      this.#logger.error("Supabase Bridge run failed", { taskId: task.id, runId, error: message });
    } finally {
      clearInterval(leaseTimer);
      this.#activeRuns.delete(task.id);
      await this.#refreshQuota("terminal_completion");
      setTimeout(() => this.#correlator.forgetBridgeRun(run.id), 30_000).unref?.();
    }
  }
}
