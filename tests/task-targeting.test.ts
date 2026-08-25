import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { legacyTaskTarget, resolveExecutionTarget } from "../src/task-targeting.js";
import type { TaskTargetRecord } from "../src/types.js";
import { configs } from "./fixtures.js";

const TASK_ID = "00000000-0000-4000-8000-000000000001";
const INSTANCE = "openclaw:test-host";
const MAIN_WORKSPACE = "F:\\RGAT-development";
const SESSION = {
  sessionKey: "agent:main:existing",
  entry: {
    sessionId: "30000000-0000-4000-8000-000000000001",
    status: "done",
  },
};

function target(overrides: Partial<TaskTargetRecord> = {}): TaskTargetRecord {
  return {
    ...legacyTaskTarget(TASK_ID),
    instanceKey: INSTANCE,
    agentId: "main",
    ...overrides,
  };
}

function host(input: { sessions?: unknown[]; agents?: unknown[] } = {}) {
  const sessions = input.sessions ?? [SESSION];
  const agents = input.agents ?? [{ id: "main", workspace: MAIN_WORKSPACE }];
  const listSessionEntries = vi.fn(() => sessions);
  const resolveAgentWorkspaceDir = vi.fn(() => MAIN_WORKSPACE);
  const api = {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir,
        resolveAgentIdentity: vi.fn(() => undefined),
        session: { listSessionEntries },
      },
    },
  } as unknown as OpenClawPluginApi;
  const cfg = {
    agents: {
      defaults: { workspace: MAIN_WORKSPACE },
      list: agents,
    },
  } as OpenClawConfig;
  return { api, cfg, listSessionEntries, resolveAgentWorkspaceDir };
}

async function resolve(inputTarget: TaskTargetRecord | null, runtime = host()) {
  return resolveExecutionTarget({
    api: runtime.api,
    cfg: runtime.cfg,
    target: inputTarget,
    taskId: TASK_ID,
    instanceKey: INSTANCE,
    selected: configs()[0]!,
    defaultWorkspace: MAIN_WORKSPACE,
    sessionIdFactory: () => "new-session-id",
  });
}

describe("exact task targeting through public plugin runtime surfaces", () => {
  it("preserves legacy isolated-session identity while still checking checkout occupancy", async () => {
    const runtime = host();
    const result = await resolve(null, runtime);
    expect(result).toMatchObject({
      legacy: true,
      requestedInstanceKey: null,
      requestedAgentId: null,
      sessionPolicy: "new",
      actualSessionKey: `agent:main:supabase-bridge:${TASK_ID}`,
      actualSessionId: "new-session-id",
      cwd: MAIN_WORKSPACE,
      queuedForBusyWorkspace: false,
    });
    expect(runtime.listSessionEntries).toHaveBeenCalled();
  });

  it("creates a clean new session at the exact configured workspace", async () => {
    const result = await resolve(target({
      sessionPolicy: "new",
      projectKey: "openclaw:test-host:path:f:\\rgat-development",
      projectPath: MAIN_WORKSPACE,
      workspaceKey: "openclaw:test-host:agent:main",
      workspacePath: MAIN_WORKSPACE,
    }));
    expect(result).toMatchObject({
      legacy: false,
      actualSessionId: "new-session-id",
      projectKey: "openclaw:test-host:path:f:\\rgat-development",
      workspaceKey: "openclaw:test-host:agent:main",
      cwd: MAIN_WORKSPACE,
    });
  });

  it("continues the exact key and durable ID", async () => {
    const result = await resolve(target({
      sessionPolicy: "continue",
      sessionKey: SESSION.sessionKey,
      sessionId: SESSION.entry.sessionId,
    }));
    expect(result.actualSessionKey).toBe(SESSION.sessionKey);
    expect(result.actualSessionId).toBe(SESSION.entry.sessionId);
    expect(result.sourceSessionKey).toBe(SESSION.sessionKey);
  });

  it("fails explicitly when transcript forking is unavailable to external plugins", async () => {
    await expect(resolve(target({
      sessionPolicy: "fork",
      sessionKey: SESSION.sessionKey,
      sessionId: SESSION.entry.sessionId,
    }))).rejects.toMatchObject({ code: "session_fork_unsupported" });
  });

  it.each([
    ["missing continue target", target({ sessionPolicy: "continue" }), "missing_session_target"],
    ["wrong instance", target({ instanceKey: "openclaw:other" }), "wrong_instance"],
    ["unavailable workspace", target({ workspaceKey: "gone" }), "workspace_unavailable"],
    ["unsupported worktree inventory", target({ worktreeKey: "gone" }), "worktree_inventory_unsupported"],
    ["unavailable project", target({ projectKey: "gone" }), "project_unavailable"],
    ["unsupported node placement", target({ nodeId: "node-1" }), "node_target_unsupported"],
  ])("fails closed for %s", async (_label, exactTarget, code) => {
    await expect(resolve(exactTarget)).rejects.toMatchObject({ code });
  });

  it("rejects stale key/ID combinations instead of selecting another session", async () => {
    await expect(resolve(target({
      sessionPolicy: "continue",
      sessionKey: "stale",
      sessionId: SESSION.entry.sessionId,
    }))).rejects.toMatchObject({ code: "stale_session_key" });
  });

  it("fails when the selected execution config points to a different agent", async () => {
    await expect(resolve(target({ agentId: "cursor" }))).rejects.toMatchObject({ code: "agent_config_mismatch" });
  });

  it("fails when an agent disappeared from the supported configured inventory", async () => {
    await expect(resolve(target(), host({ agents: [{ id: "cursor", workspace: MAIN_WORKSPACE }] })))
      .rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("queues an exact busy session without changing its identity", async () => {
    const busy = { ...SESSION, entry: { ...SESSION.entry, status: "running" } };
    const result = await resolve(target({
      sessionPolicy: "continue",
      sessionKey: busy.sessionKey,
      sessionId: busy.entry.sessionId,
      busyPolicy: "queue",
    }), host({ sessions: [busy] }));
    expect(result).toMatchObject({ actualSessionKey: busy.sessionKey, queuedForBusySession: true, busyPolicy: "queue" });
  });

  it("rejects an exact busy session when requested", async () => {
    const busy = { ...SESSION, entry: { ...SESSION.entry, status: "running" } };
    await expect(resolve(target({
      sessionPolicy: "continue",
      sessionKey: busy.sessionKey,
      sessionId: busy.entry.sessionId,
      busyPolicy: "reject",
    }), host({ sessions: [busy] }))).rejects.toMatchObject({ code: "target_busy" });
  });

  it("queues a new session when another active session already occupies the checkout", async () => {
    const other = {
      sessionKey: "agent:main:supabase-bridge:other-task",
      entry: {
        sessionId: "40000000-0000-4000-8000-000000000001",
        status: "running",
      },
    };
    const result = await resolve(target({
      sessionPolicy: "new",
      workspaceKey: "openclaw:test-host:agent:main",
      workspacePath: MAIN_WORKSPACE,
      busyPolicy: "queue",
    }), host({ sessions: [SESSION, other] }));
    expect(result).toMatchObject({
      queuedForBusyWorkspace: true,
      busyCheckoutSessionKey: other.sessionKey,
      actualSessionId: "new-session-id",
      cwd: MAIN_WORKSPACE,
    });
  });

  it("rejects a new session when the checkout is occupied and busy_policy is reject", async () => {
    const other = {
      sessionKey: "agent:main:supabase-bridge:other-task",
      entry: {
        sessionId: "40000000-0000-4000-8000-000000000001",
        status: "running",
      },
    };
    await expect(resolve(target({
      sessionPolicy: "new",
      workspacePath: MAIN_WORKSPACE,
      busyPolicy: "reject",
    }), host({ sessions: [other] }))).rejects.toMatchObject({ code: "workspace_busy" });
  });

  it("does not treat the continued session as a foreign checkout occupant", async () => {
    const busy = { ...SESSION, entry: { ...SESSION.entry, status: "running" } };
    const result = await resolve(target({
      sessionPolicy: "continue",
      sessionKey: busy.sessionKey,
      sessionId: busy.entry.sessionId,
      busyPolicy: "queue",
    }), host({ sessions: [busy] }));
    expect(result).toMatchObject({
      queuedForBusySession: true,
      queuedForBusyWorkspace: false,
      busyCheckoutSessionKey: null,
    });
  });

  it("uses spawned cwd when present instead of the agent workspace fallback", async () => {
    const other = {
      sessionKey: "agent:main:child",
      entry: {
        sessionId: "40000000-0000-4000-8000-000000000002",
        status: "running",
        spawnedCwd: "F:\\RGAT-development\\.worktrees\\feature",
      },
    };
    const result = await resolve(target({
      sessionPolicy: "new",
      workspacePath: MAIN_WORKSPACE,
      busyPolicy: "queue",
    }), host({ sessions: [other] }));
    expect(result.queuedForBusyWorkspace).toBe(false);
  });
});
