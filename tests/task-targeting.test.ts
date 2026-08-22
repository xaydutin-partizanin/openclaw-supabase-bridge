import { describe, expect, it, vi } from "vitest";
import { ExactTargetError, legacyTaskTarget, resolveExecutionTarget, type TargetingGateway } from "../src/task-targeting.js";
import type { TaskTargetRecord } from "../src/types.js";
import { configs } from "./fixtures.js";

const TASK_ID = "00000000-0000-4000-8000-000000000001";
const INSTANCE = "openclaw:test-host";
const MAIN_WORKSPACE = "F:\\RGAT-development";
const SESSION = {
  key: "agent:main:existing",
  sessionId: "30000000-0000-4000-8000-000000000001",
  agentId: "main",
  hasActiveRun: false,
};

function target(overrides: Partial<TaskTargetRecord> = {}): TaskTargetRecord {
  return {
    ...legacyTaskTarget(TASK_ID),
    instanceKey: INSTANCE,
    agentId: "main",
    ...overrides,
  };
}

function gateway(overrides: { session?: typeof SESSION; worktrees?: unknown[] } = {}): { request: ReturnType<typeof vi.fn> } {
  const session = overrides.session ?? SESSION;
  const worktrees = overrides.worktrees ?? [{ id: "wt-1", path: "F:\\RGAT-development\\.worktrees\\one", repoRoot: MAIN_WORKSPACE, agentId: "main" }];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "agents.list") return { agents: [{ id: "main", workspace: MAIN_WORKSPACE }] };
    if (method === "worktrees.list") return { worktrees };
    if (method === "sessions.resolve") {
      if (params?.key === "missing" || params?.sessionId === "missing") return { ok: false };
      return { ok: true, session };
    }
    if (method === "sessions.list") return { sessions: [session] };
    if (method === "sessions.create") return { key: "agent:main:supabase-bridge:fork", sessionId: "fork-id" };
    throw new Error(`Unexpected RPC ${method}`);
  });
  return { request };
}

async function resolve(inputTarget: TaskTargetRecord | null, gw = gateway()) {
  return resolveExecutionTarget({
    gateway: gw as unknown as TargetingGateway,
    target: inputTarget,
    taskId: TASK_ID,
    instanceKey: INSTANCE,
    selected: configs()[0]!,
    defaultWorkspace: MAIN_WORKSPACE,
    sessionIdFactory: () => "new-session-id",
  });
}

describe("exact task targeting", () => {
  it("preserves legacy isolated-session behavior without inventory RPCs", async () => {
    const gw = gateway();
    const result = await resolve(null, gw);
    expect(result).toMatchObject({
      legacy: true,
      requestedInstanceKey: null,
      requestedAgentId: null,
      sessionPolicy: "new",
      actualSessionKey: `agent:main:supabase-bridge:${TASK_ID}`,
      actualSessionId: "new-session-id",
      cwd: MAIN_WORKSPACE,
    });
    expect(gw.request).not.toHaveBeenCalled();
  });

  it("creates a clean new session at an exact managed worktree", async () => {
    const result = await resolve(target({
      sessionPolicy: "new",
      projectKey: "openclaw:test-host:path:f:\\rgat-development",
      projectPath: MAIN_WORKSPACE,
      workspaceKey: "openclaw:test-host:agent:main",
      worktreeKey: "openclaw:test-host:wt-1",
      worktreePath: "F:\\RGAT-development\\.worktrees\\one",
    }));
    expect(result).toMatchObject({
      legacy: false,
      actualSessionId: "new-session-id",
      projectKey: "openclaw:test-host:path:f:\\rgat-development",
      workspaceKey: "openclaw:test-host:agent:main",
      worktreeKey: "openclaw:test-host:wt-1",
      cwd: "F:\\RGAT-development\\.worktrees\\one",
    });
  });

  it("continues the exact key and durable ID", async () => {
    const result = await resolve(target({ sessionPolicy: "continue", sessionKey: SESSION.key, sessionId: SESSION.sessionId }));
    expect(result.actualSessionKey).toBe(SESSION.key);
    expect(result.actualSessionId).toBe(SESSION.sessionId);
    expect(result.sourceSessionKey).toBe(SESSION.key);
  });

  it("forks through the public sessions.create API", async () => {
    const gw = gateway();
    const result = await resolve(target({ sessionPolicy: "fork", sessionKey: SESSION.key, sessionId: SESSION.sessionId }), gw);
    expect(result).toMatchObject({ sourceSessionKey: SESSION.key, actualSessionKey: "agent:main:supabase-bridge:fork", actualSessionId: "fork-id" });
    expect(gw.request).toHaveBeenCalledWith("sessions.create", expect.objectContaining({ parentSessionKey: SESSION.key, fork: true }));
  });

  it.each([
    ["missing continue target", target({ sessionPolicy: "continue" }), "missing_session_target"],
    ["wrong instance", target({ instanceKey: "openclaw:other" }), "wrong_instance"],
    ["unavailable workspace", target({ workspaceKey: "gone" }), "workspace_unavailable"],
    ["unavailable worktree", target({ worktreeKey: "gone" }), "worktree_unavailable"],
    ["unavailable project", target({ projectKey: "gone" }), "project_unavailable"],
    ["unsupported node placement", target({ nodeId: "node-1" }), "node_target_unsupported"],
  ])("fails closed for %s", async (_label, exactTarget, code) => {
    await expect(resolve(exactTarget)).rejects.toMatchObject({ code });
  });

  it("rejects stale key/ID combinations instead of selecting another session", async () => {
    const gw = gateway();
    await expect(resolve(target({ sessionPolicy: "continue", sessionKey: "stale", sessionId: SESSION.sessionId }), gw))
      .rejects.toMatchObject({ code: "stale_session_key" });
    expect(gw.request).not.toHaveBeenCalledWith("sessions.create", expect.anything());
  });

  it("fails when the selected execution config points to a different agent", async () => {
    await expect(resolve(target({ agentId: "cursor" }))).rejects.toMatchObject({ code: "agent_config_mismatch" });
  });

  it("fails when an agent disappeared from the supported inventory", async () => {
    const gw = gateway();
    gw.request.mockImplementation(async (method: string) => method === "agents.list" ? { agents: [] } : { worktrees: [] });
    await expect(resolve(target(), gw)).rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("rejects a worktree explicitly owned by another agent", async () => {
    const gw = gateway({ worktrees: [{ id: "wt-1", path: "F:\\other", repoRoot: "F:\\repo", agentId: "cursor" }] });
    await expect(resolve(target({ worktreeKey: "openclaw:test-host:wt-1" }), gw)).rejects.toMatchObject({ code: "worktree_agent_mismatch" });
  });

  it("queues an exact busy session without changing its identity", async () => {
    const busy = { ...SESSION, hasActiveRun: true };
    const result = await resolve(target({ sessionPolicy: "continue", sessionKey: busy.key, sessionId: busy.sessionId, busyPolicy: "queue" }), gateway({ session: busy }));
    expect(result).toMatchObject({ actualSessionKey: busy.key, queuedForBusySession: true, busyPolicy: "queue" });
  });

  it("rejects an exact busy session when requested", async () => {
    const busy = { ...SESSION, hasActiveRun: true };
    await expect(resolve(target({ sessionPolicy: "continue", sessionKey: busy.key, sessionId: busy.sessionId, busyPolicy: "reject" }), gateway({ session: busy })))
      .rejects.toMatchObject({ code: "target_busy" });
  });
});
