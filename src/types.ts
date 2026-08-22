export type JsonPrimitive = null | boolean | number | string;
export type Json = JsonPrimitive | Json[] | { [key: string]: Json };

export type BridgeTaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type BridgeRunStatus = Exclude<BridgeTaskStatus, "pending"> | "created";

export type TaskSessionPolicy = "new" | "continue" | "fork";
export type TaskBusyPolicy = "queue" | "reject";

export interface TaskTargetRecord {
  taskId: string;
  instanceKey: string | null;
  agentId: string | null;
  sessionPolicy: TaskSessionPolicy;
  sessionKey: string | null;
  sessionId: string | null;
  projectKey: string | null;
  projectPath: string | null;
  workspaceKey: string | null;
  workspacePath: string | null;
  worktreeKey: string | null;
  worktreePath: string | null;
  nodeKey: string | null;
  nodeId: string | null;
  busyPolicy: TaskBusyPolicy;
  metadata: Record<string, Json>;
}

export interface ExecutionTargetPlan {
  legacy: boolean;
  requestedInstanceKey: string | null;
  instanceKey: string;
  requestedAgentId: string | null;
  agentId: string;
  sessionPolicy: TaskSessionPolicy;
  sourceSessionKey: string | null;
  sourceSessionId: string | null;
  actualSessionKey: string;
  actualSessionId: string;
  projectKey: string | null;
  projectPath: string | null;
  workspaceKey: string | null;
  workspacePath: string;
  worktreeKey: string | null;
  worktreePath: string | null;
  nodeKey: string | null;
  nodeId: string | null;
  cwd: string;
  busyPolicy: TaskBusyPolicy;
  queuedForBusySession: boolean;
}

export interface ProviderRecord {
  id?: string;
  providerKey: string;
  name: string;
  available: boolean;
  metadata: Record<string, Json>;
  updatedAt: string;
}

export interface AgentConfigRecord {
  id?: string;
  configKey: string;
  providerId?: string;
  providerKey: string;
  runtime: "native" | "acp" | string;
  agent: string;
  model: string | null;
  effort: string | null;
  available: boolean;
  isDefault: boolean;
  other: Record<string, Json>;
  updatedAt: string;
}

export interface BridgeTask {
  id: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  requestedConfig: string | null;
  status: BridgeTaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  metadata: Record<string, Json>;
}

export interface BridgeRun {
  id: string;
  taskId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: BridgeRunStatus;
  requestedConfig: string | null;
  usedConfig: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  configId: string | null;
  providerId: string | null;
  providerKey: string | null;
  runtime: string | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  openclawTaskId: string | null;
  openclawRunId: string | null;
  parentSessionKey: string | null;
  parentSessionId: string | null;
  error: string | null;
  metadata: Record<string, Json>;
}

export interface BridgeReport {
  id?: string;
  taskId: string;
  runId: string;
  createdAt: string;
  status: BridgeTaskStatus;
  reportText: string;
  report: Record<string, Json>;
}

export interface BridgeEvent {
  eventKey: string;
  taskId: string;
  runId: string;
  createdAt: string;
  eventTs: string;
  sourceRunId: string | null;
  sourceSessionKey: string | null;
  sourceSessionId: string | null;
  sourceAgentId: string | null;
  lifecycleGeneration: string | null;
  seq: number | null;
  stream: string | null;
  eventType: string | null;
  data: Record<string, Json>;
}

export type QuotaStatusValue = "ok" | "unknown" | "unsupported" | "error";

export interface QuotaStatus {
  id?: string;
  quotaIdentity: string;
  providerId: string;
  providerKey: string;
  configId?: string | null;
  configKey?: string | null;
  accountKey: string;
  quotaKey: string;
  remaining: number | null;
  limitValue: number | null;
  unit: string | null;
  resetAt: string | null;
  checkedAt: string;
  status: QuotaStatusValue;
  source: string | null;
  other: Record<string, Json>;
}

export type FallbackReason =
  | "missing_requested_config"
  | "unknown_config"
  | "config_unavailable"
  | "provider_unavailable"
  | "invalid_option";

export interface ResolvedExecutionConfig {
  requestedConfig: string | null;
  config: AgentConfigRecord;
  fallbackUsed: boolean;
  fallbackReason: FallbackReason | null;
}

export interface PluginConfig {
  enabled: boolean;
  supabaseUrl: string | null;
  supabaseCredential: string | null;
  credentialConfigured: boolean;
  workerId: string;
  quotaRefreshIntervalMinutes: number;
  eventLoggingEnabled: boolean;
  eventMaxPayloadBytes: number;
  leaseDurationSeconds: number;
  instanceKey: string;
  telemetryEnabled: boolean;
  telemetryHeartbeatSeconds: number;
}

export type FreshnessState = "fresh" | "stale" | "error" | "unsupported";

export interface TelemetryRow {
  [key: string]: Json | undefined;
}

export interface TelemetryWrite {
  table: string;
  rows: TelemetryRow[];
  onConflict: string;
}

export interface OperationalEventInput {
  eventKey: string;
  instanceKey: string;
  bootId: string;
  source: string;
  domain: string;
  severity: "debug" | "info" | "warning" | "error";
  eventType: string;
  eventTs: string;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  summary?: string | null;
  data: Record<string, Json>;
}

export interface InventorySnapshot {
  providers: ProviderRecord[];
  configs: AgentConfigRecord[];
  refreshedAt: string;
}

export interface InventoryIds {
  providerIds: Map<string, string>;
  configIds: Map<string, string>;
}

export interface OpenClawAgentEvent {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  lifecycleGeneration?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}

export interface CorrelatedAgentEvent {
  taskId: string;
  bridgeRunId: string;
  event: OpenClawAgentEvent;
}

export interface TerminalWriteInput {
  taskId: string;
  runId: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  reportText: string;
  report: Record<string, Json>;
  error: string | null;
  metadata: Record<string, Json>;
  openclawRunId: string | null;
  openclawTaskId: string | null;
  actualProviderKey: string | null;
  actualModel: string | null;
}
