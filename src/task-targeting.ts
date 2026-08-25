import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { asRecord, asString } from "./object-utils.js";
import { listAllSessionEntries, listConfiguredAgents } from "./telemetry/public-runtime.js";
import type { AgentConfigRecord, ExecutionTargetPlan, TaskTargetRecord } from "./types.js";

export class ExactTargetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExactTargetError";
    this.code = code;
  }
}

interface SessionCandidate {
  key: string;
  sessionId: string;
  agentId: string;
  hasActiveRun: boolean;
}

interface WorkspaceCandidate {
  key: string;
  upstreamId: string | null;
  path: string;
  agentId: string | null;
}

interface ProjectCandidate {
  key: string;
  path: string;
}

function stableTargetKey(...parts: Array<string | number | null | undefined>): string {
  return parts.map((part) => String(part ?? "").trim().toLowerCase()).join(":");
}

export function normalizedCheckoutPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizedPath(value: string): string {
  return normalizedCheckoutPath(value);
}

export interface CheckoutOccupant {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  checkoutPath: string;
}

/** Write-capable checkout occupancy from live OpenClaw session entries. */
export function listCheckoutOccupants(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
  defaultWorkspace: string,
): CheckoutOccupant[] {
  const agents = listConfiguredAgents(api, cfg);
  const occupants: CheckoutOccupant[] = [];
  for (const summary of listAllSessionEntries(api, cfg)) {
    const candidate = sessionCandidate(summary);
    if (!candidate?.hasActiveRun) continue;
    const entry = asRecord(asRecord(summary).entry);
    const spawned =
      asString(entry.spawnedCwd) ??
      asString(entry.spawnedWorkspaceDir) ??
      asString(entry.cwd) ??
      asString(entry.workspaceDir);
    const agent = agents.find((row) => row.id === candidate.agentId);
    const fallback = agent?.workspacePath || defaultWorkspace;
    const checkout = spawned || fallback;
    if (!checkout) continue;
    occupants.push({
      sessionKey: candidate.key,
      sessionId: candidate.sessionId,
      agentId: candidate.agentId,
      checkoutPath: normalizedPath(checkout),
    });
  }
  return occupants;
}

export function findBusyCheckoutOccupant(
  cwd: string,
  occupants: CheckoutOccupant[],
  excludeSessionKey?: string | null,
): CheckoutOccupant | null {
  const wanted = normalizedPath(cwd);
  return occupants.find((row) => {
    if (excludeSessionKey && row.sessionKey === excludeSessionKey) return false;
    return row.checkoutPath === wanted;
  }) ?? null;
}

function sessionAgentId(key: string, explicit?: unknown): string {
  const value = asString(explicit);
  if (value) return value;
  const match = /^agent:([^:]+):/.exec(key);
  return match?.[1] ?? "main";
}

function sessionCandidate(summary: unknown): SessionCandidate | null {
  const row = asRecord(summary);
  const entry = asRecord(row.entry);
  const key = asString(row.sessionKey);
  const sessionId = asString(entry.sessionId);
  if (!key || !sessionId) return null;
  return {
    key,
    sessionId,
    agentId: sessionAgentId(key),
    hasActiveRun: asString(entry.status) === "running" || Boolean(asString(entry.restartRecoveryDeliveryRunId)),
  };
}

function resolveExactSession(api: OpenClawPluginApi, cfg: OpenClawConfig, target: TaskTargetRecord): SessionCandidate {
  if (!target.sessionKey && !target.sessionId) {
    throw new ExactTargetError("missing_session_target", `${target.sessionPolicy} requires session_key or session_id`);
  }
  const sessions = listAllSessionEntries(api, cfg)
    .map(sessionCandidate)
    .filter((candidate): candidate is SessionCandidate => candidate !== null);
  const byKey = target.sessionKey ? sessions.find((candidate) => candidate.key === target.sessionKey) ?? null : null;
  const byId = target.sessionId ? sessions.find((candidate) => candidate.sessionId === target.sessionId) ?? null : null;
  const selected = byKey ?? byId;
  if (!selected) throw new ExactTargetError("session_not_found", "The requested OpenClaw session does not exist");
  if (byKey && byId && (byKey.key !== byId.key || byKey.sessionId !== byId.sessionId)) {
    throw new ExactTargetError("session_identity_mismatch", "session_key and session_id resolve to different sessions");
  }
  if (target.sessionKey && selected.key !== target.sessionKey) {
    throw new ExactTargetError("stale_session_key", "The requested session key no longer identifies the expected session");
  }
  if (target.sessionId && selected.sessionId !== target.sessionId) {
    throw new ExactTargetError("stale_session_id", "The requested session ID no longer identifies the expected session");
  }
  return selected;
}

async function resolvePlacement(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
  target: TaskTargetRecord,
  selected: AgentConfigRecord,
  defaultWorkspace: string,
  instanceKey: string,
): Promise<{
  projectKey: string | null;
  projectPath: string | null;
  workspaceKey: string | null;
  workspacePath: string;
  worktreeKey: string | null;
  worktreePath: string | null;
  cwd: string;
}> {
  const agents = listConfiguredAgents(api, cfg);
  const agent = agents.find((row) => row.id === selected.agent);
  if (!agent) throw new ExactTargetError("agent_unavailable", `Agent ${selected.agent} is unavailable`);
  const agentWorkspace = agent.workspacePath || defaultWorkspace;
  const candidates: WorkspaceCandidate[] = [
    {
      key: stableTargetKey(instanceKey, "agent", selected.agent),
      upstreamId: selected.agent,
      path: agentWorkspace,
      agentId: selected.agent,
    },
  ];
  const projects: ProjectCandidate[] = [
    { key: stableTargetKey(instanceKey, "path", agentWorkspace), path: agentWorkspace },
  ];

  const findCandidate = (key: string | null, requestedPath: string | null): WorkspaceCandidate | null => {
    if (key) {
      const byKey = candidates.find((candidate) => candidate.key === key || candidate.upstreamId === key);
      if (!byKey) return null;
      if (requestedPath && normalizedPath(byKey.path) !== normalizedPath(requestedPath)) return null;
      return byKey;
    }
    if (!requestedPath) return null;
    return candidates.find((candidate) => normalizedPath(candidate.path) === normalizedPath(requestedPath)) ?? null;
  };

  if (target.worktreeKey || target.worktreePath) {
    throw new ExactTargetError(
      "worktree_inventory_unsupported",
      "OpenClaw 2026.7.1-2 does not expose managed worktree inventory to external plugins; target a configured workspace instead",
    );
  }

  const workspace = target.workspaceKey || target.workspacePath
    ? findCandidate(target.workspaceKey, target.workspacePath)
    : candidates[0]!;
  if (!workspace) {
    throw new ExactTargetError("workspace_unavailable", "The requested workspace is unavailable or its ID/path changed");
  }
  if (workspace.agentId && workspace.agentId !== selected.agent) {
    throw new ExactTargetError("workspace_agent_mismatch", "The requested workspace belongs to a different agent");
  }

  const requestedProjectPath = target.projectPath;
  let project: ProjectCandidate | null = null;
  if (target.projectKey || requestedProjectPath) {
    project = projects.find((candidate) => {
      const pathMatches = !requestedProjectPath || normalizedPath(candidate.path) === normalizedPath(requestedProjectPath);
      const keyMatches = !target.projectKey || candidate.key === target.projectKey;
      return pathMatches && keyMatches;
    }) ?? null;
    if (!project) {
      throw new ExactTargetError("project_unavailable", "The requested project is not exposed by OpenClaw's workspace/worktree inventory");
    }
  }

  const cwd = workspace.path;
  return {
    projectKey: target.projectKey ?? project?.key ?? null,
    projectPath: requestedProjectPath ?? project?.path ?? null,
    workspaceKey: target.workspaceKey ?? workspace.key,
    workspacePath: workspace.path,
    worktreeKey: null,
    worktreePath: null,
    cwd,
  };
}

export function legacyTaskTarget(taskId: string): TaskTargetRecord {
  return {
    taskId,
    instanceKey: null,
    agentId: null,
    sessionPolicy: "new",
    sessionKey: null,
    sessionId: null,
    projectKey: null,
    projectPath: null,
    workspaceKey: null,
    workspacePath: null,
    worktreeKey: null,
    worktreePath: null,
    nodeKey: null,
    nodeId: null,
    busyPolicy: "queue",
    metadata: {},
  };
}

export async function resolveExecutionTarget(input: {
  api: OpenClawPluginApi;
  cfg: OpenClawConfig;
  target: TaskTargetRecord | null;
  taskId: string;
  instanceKey: string;
  selected: AgentConfigRecord;
  defaultWorkspace: string;
  sessionIdFactory?: () => string;
}): Promise<ExecutionTargetPlan> {
  const target = input.target ?? legacyTaskTarget(input.taskId);
  const legacy = input.target === null;
  if (target.instanceKey && target.instanceKey !== input.instanceKey) {
    throw new ExactTargetError("wrong_instance", `Task targets ${target.instanceKey}, not ${input.instanceKey}`);
  }
  if (target.agentId && target.agentId !== input.selected.agent) {
    throw new ExactTargetError(
      "agent_config_mismatch",
      `Requested agent ${target.agentId} does not match execution config agent ${input.selected.agent}`,
    );
  }
  if (target.nodeKey || target.nodeId) {
    throw new ExactTargetError(
      "node_target_unsupported",
      "This OpenClaw build exposes node inventory but not a public node-placement field for embedded agent runs",
    );
  }

  const sessionIdFactory = input.sessionIdFactory ?? randomUUID;
  if (legacy) {
    const legacyPlan: ExecutionTargetPlan = {
      legacy: true,
      requestedInstanceKey: null,
      instanceKey: input.instanceKey,
      requestedAgentId: null,
      agentId: input.selected.agent,
      sessionPolicy: "new",
      sourceSessionKey: null,
      sourceSessionId: null,
      actualSessionKey: `agent:${input.selected.agent}:supabase-bridge:${input.taskId}`,
      actualSessionId: sessionIdFactory(),
      projectKey: null,
      projectPath: null,
      workspaceKey: stableTargetKey(input.instanceKey, "agent", input.selected.agent),
      workspacePath: input.defaultWorkspace,
      worktreeKey: null,
      worktreePath: null,
      nodeKey: null,
      nodeId: null,
      cwd: input.defaultWorkspace,
      busyPolicy: "queue",
      queuedForBusySession: false,
      queuedForBusyWorkspace: false,
      busyCheckoutSessionKey: null,
    };
    return applyCheckoutBusyPolicy(legacyPlan, input);
  }

  const placement = await resolvePlacement(input.api, input.cfg, target, input.selected, input.defaultWorkspace, input.instanceKey);
  let source: SessionCandidate | null = null;
  let actualSessionKey = `agent:${input.selected.agent}:supabase-bridge:${input.taskId}`;
  let actualSessionId = sessionIdFactory();
  let queuedForBusySession = false;

  if (target.sessionPolicy === "continue" || target.sessionPolicy === "fork") {
    source = resolveExactSession(input.api, input.cfg, target);
    if (source.agentId !== input.selected.agent) {
      throw new ExactTargetError("session_agent_mismatch", "The requested session belongs to a different agent");
    }
    if (source.hasActiveRun && target.busyPolicy === "reject") {
      throw new ExactTargetError("target_busy", "The requested session currently has an active run");
    }
    queuedForBusySession = source.hasActiveRun;
    if (target.sessionPolicy === "continue") {
      actualSessionKey = source.key;
      actualSessionId = source.sessionId;
    } else {
      throw new ExactTargetError(
        "session_fork_unsupported",
        "OpenClaw 2026.7.1-2 has no supported external-plugin API for atomically forking a session transcript",
      );
    }
  }

  const plan: ExecutionTargetPlan = {
    legacy,
    requestedInstanceKey: target.instanceKey,
    instanceKey: input.instanceKey,
    requestedAgentId: target.agentId,
    agentId: input.selected.agent,
    sessionPolicy: target.sessionPolicy,
    sourceSessionKey: source?.key ?? null,
    sourceSessionId: source?.sessionId ?? null,
    actualSessionKey,
    actualSessionId,
    ...placement,
    nodeKey: target.nodeKey,
    nodeId: target.nodeId,
    busyPolicy: target.busyPolicy,
    queuedForBusySession,
    queuedForBusyWorkspace: false,
    busyCheckoutSessionKey: null,
  };
  return applyCheckoutBusyPolicy(plan, input);
}

function applyCheckoutBusyPolicy(
  plan: ExecutionTargetPlan,
  input: {
    api: OpenClawPluginApi;
    cfg: OpenClawConfig;
    defaultWorkspace: string;
  },
): ExecutionTargetPlan {
  // Distinct managed worktrees are unsupported today; when present they would be a
  // separate checkout resource. Same normalized path remains exclusive.
  const excludeSessionKey = plan.sessionPolicy === "continue" ? plan.actualSessionKey : null;
  const occupant = findBusyCheckoutOccupant(
    plan.cwd,
    listCheckoutOccupants(input.api, input.cfg, input.defaultWorkspace),
    excludeSessionKey,
  );
  if (!occupant) return plan;
  if (plan.busyPolicy === "reject") {
    throw new ExactTargetError(
      "workspace_busy",
      `Checkout ${plan.cwd} already has an active write-capable run in session ${occupant.sessionKey}`,
    );
  }
  return {
    ...plan,
    queuedForBusyWorkspace: true,
    busyCheckoutSessionKey: occupant.sessionKey,
  };
}
