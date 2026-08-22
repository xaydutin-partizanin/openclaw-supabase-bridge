import { randomUUID } from "node:crypto";
import path from "node:path";
import { asBoolean, asRecord, asString } from "./object-utils.js";
import type { AgentConfigRecord, ExecutionTargetPlan, TaskTargetRecord } from "./types.js";

export class ExactTargetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExactTargetError";
    this.code = code;
  }
}

export interface TargetingGateway {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
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

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sessionAgentId(key: string, explicit?: unknown): string {
  const value = asString(explicit);
  if (value) return value;
  const match = /^agent:([^:]+):/.exec(key);
  return match?.[1] ?? "main";
}

function sessionCandidate(value: unknown): SessionCandidate | null {
  const row = asRecord(value);
  const key = asString(row.key) ?? asString(row.sessionKey);
  const sessionId = asString(row.sessionId);
  if (!key || !sessionId) return null;
  return {
    key,
    sessionId,
    agentId: sessionAgentId(key, row.agentId),
    hasActiveRun: asBoolean(row.hasActiveRun, false),
  };
}

async function resolveExactSession(gateway: TargetingGateway, target: TaskTargetRecord): Promise<SessionCandidate> {
  if (!target.sessionKey && !target.sessionId) {
    throw new ExactTargetError("missing_session_target", `${target.sessionPolicy} requires session_key or session_id`);
  }

  const resolve = async (params: Record<string, unknown>): Promise<SessionCandidate | null> => {
    const result = asRecord(await gateway.request("sessions.resolve", { ...params, allowMissing: true }));
    if (result.ok === false) return null;
    return sessionCandidate(result.session ?? result);
  };

  const byKey = target.sessionKey ? await resolve({ key: target.sessionKey }) : null;
  const byId = target.sessionId ? await resolve({ sessionId: target.sessionId }) : null;
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
  try {
    const listed = asRecord(await gateway.request("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      limit: 1_000,
    }));
    const sessions = Array.isArray(listed.sessions) ? listed.sessions.map(sessionCandidate).filter((row): row is SessionCandidate => row !== null) : [];
    const exact = sessions.find((candidate) => candidate.key === selected.key && candidate.sessionId === selected.sessionId);
    if (!exact) {
      throw new ExactTargetError(
        "session_activity_unavailable",
        "The requested session resolved, but its current activity state could not be verified",
      );
    }
    return exact;
  } catch (error) {
    if (error instanceof ExactTargetError) throw error;
    throw new ExactTargetError(
      "session_activity_unavailable",
      "The requested session resolved, but OpenClaw did not provide its current activity state",
    );
  }
}

async function resolvePlacement(
  gateway: TargetingGateway,
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
  const agentsResult = asRecord(await gateway.request("agents.list"));
  const agents = Array.isArray(agentsResult.agents) ? agentsResult.agents.map(asRecord) : [];
  const agent = agents.find((row) => asString(row.id) === selected.agent);
  if (!agent) throw new ExactTargetError("agent_unavailable", `Agent ${selected.agent} is unavailable`);
  const agentWorkspace = asString(agent.workspace) ?? defaultWorkspace;

  const worktreesResult = asRecord(await gateway.request("worktrees.list"));
  const worktrees = Array.isArray(worktreesResult.worktrees) ? worktreesResult.worktrees.map(asRecord) : [];
  const candidates: WorkspaceCandidate[] = [
    {
      key: stableTargetKey(instanceKey, "agent", selected.agent),
      upstreamId: selected.agent,
      path: agentWorkspace,
      agentId: selected.agent,
    },
    ...worktrees.flatMap((row): WorkspaceCandidate[] => {
      const worktreePath = asString(row.path);
      if (!worktreePath) return [];
      const id = asString(row.id);
      return [{
        key: id ? stableTargetKey(instanceKey, id) : stableTargetKey(instanceKey, "path", worktreePath),
        upstreamId: id,
        path: worktreePath,
        agentId: asString(row.agentId),
      }];
    }),
  ];
  const projects: ProjectCandidate[] = [
    { key: stableTargetKey(instanceKey, "path", agentWorkspace), path: agentWorkspace },
    ...worktrees.flatMap((row): ProjectCandidate[] => {
      const repoRoot = asString(row.repoRoot);
      return repoRoot ? [{ key: stableTargetKey(instanceKey, "path", repoRoot), path: repoRoot }] : [];
    }),
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

  const worktree = target.worktreeKey || target.worktreePath
    ? findCandidate(target.worktreeKey, target.worktreePath)
    : null;
  if ((target.worktreeKey || target.worktreePath) && !worktree) {
    throw new ExactTargetError("worktree_unavailable", "The requested managed worktree is unavailable or its ID/path changed");
  }
  if (worktree?.agentId && worktree.agentId !== selected.agent) {
    throw new ExactTargetError("worktree_agent_mismatch", "The requested worktree belongs to a different agent");
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

  const cwd = worktree?.path ?? workspace.path;
  return {
    projectKey: target.projectKey ?? project?.key ?? null,
    projectPath: requestedProjectPath ?? project?.path ?? null,
    workspaceKey: target.workspaceKey ?? workspace.key,
    workspacePath: workspace.path,
    worktreeKey: worktree?.key ?? null,
    worktreePath: worktree?.path ?? null,
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
  gateway: TargetingGateway;
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
    return {
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
    };
  }

  const placement = await resolvePlacement(input.gateway, target, input.selected, input.defaultWorkspace, input.instanceKey);
  let source: SessionCandidate | null = null;
  let actualSessionKey = `agent:${input.selected.agent}:supabase-bridge:${input.taskId}`;
  let actualSessionId = sessionIdFactory();
  let queuedForBusySession = false;

  if (target.sessionPolicy === "continue" || target.sessionPolicy === "fork") {
    source = await resolveExactSession(input.gateway, target);
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
      const created = asRecord(await input.gateway.request("sessions.create", {
        key: actualSessionKey,
        agentId: input.selected.agent,
        parentSessionKey: source.key,
        fork: true,
        emitCommandHooks: true,
      }));
      const createdKey = asString(created.key);
      const createdSessionId = asString(created.sessionId);
      if (!createdKey || !createdSessionId) {
        throw new ExactTargetError("fork_failed", "OpenClaw did not return an exact key and ID for the forked session");
      }
      actualSessionKey = createdKey;
      actualSessionId = createdSessionId;
    }
  }

  return {
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
  };
}
