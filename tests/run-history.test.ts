import { describe, expect, it } from "vitest";
import { buildStartRunRpcParams } from "../src/database.js";
import { resolveExecutionConfig } from "../src/config-resolution.js";
import { configs, task } from "./fixtures.js";
import type { ExecutionTargetPlan } from "../src/types.js";

function plan(overrides: Partial<ExecutionTargetPlan> = {}): ExecutionTargetPlan {
  return {
    legacy: false,
    requestedInstanceKey: "openclaw:test",
    instanceKey: "openclaw:test",
    requestedAgentId: "main",
    agentId: "main",
    sessionPolicy: "fork",
    sourceSessionKey: "agent:main:source",
    sourceSessionId: "source-id",
    actualSessionKey: "agent:main:fork",
    actualSessionId: "fork-id",
    projectKey: "project-1",
    projectPath: "F:\\RGAT-development",
    workspaceKey: "workspace-1",
    workspacePath: "F:\\RGAT-development",
    worktreeKey: "worktree-1",
    worktreePath: "F:\\RGAT-development\\.worktrees\\one",
    nodeKey: null,
    nodeId: null,
    cwd: "F:\\RGAT-development\\.worktrees\\one",
    busyPolicy: "queue",
    queuedForBusySession: false,
    ...overrides,
  };
}

describe("run historical truth", () => {
  it("records requested and actual config, target, and fork identities", () => {
    const resolved = resolveExecutionConfig("main:native:openai:gpt-5-6-sol:low", configs());
    const params = buildStartRunRpcParams({
      runId: "run-id",
      task: task(),
      workerId: "worker",
      resolved,
      configId: "config-id",
      providerId: "provider-id",
      parentSessionKey: "agent:main:fork",
      parentSessionId: "fork-id",
      target: plan(),
      metadata: {},
    });
    expect(params).toMatchObject({
      p_requested_config: "main:native:openai:gpt-5-6-sol:low",
      p_used_config: "main:native:openai:gpt-5-6-sol:low",
      p_requested_instance_key: "openclaw:test",
      p_actual_instance_key: "openclaw:test",
      p_source_session_key: "agent:main:source",
      p_actual_session_key: "agent:main:fork",
      p_worktree_key: "worktree-1",
    });
  });

  it("records sensible null requested-target fields for legacy work", () => {
    const resolved = resolveExecutionConfig(null, configs());
    const params = buildStartRunRpcParams({
      runId: "run-id",
      task: task(),
      workerId: "worker",
      resolved,
      configId: "config-id",
      providerId: "provider-id",
      parentSessionKey: "agent:main:legacy",
      parentSessionId: "legacy-id",
      target: plan({ legacy: true, requestedInstanceKey: null, requestedAgentId: null, sessionPolicy: "new", sourceSessionKey: null, sourceSessionId: null }),
      metadata: { legacy_targeting: true },
    });
    expect(params.p_requested_instance_key).toBeNull();
    expect(params.p_requested_agent_id).toBeNull();
    expect(params.p_actual_agent_id).toBe("main");
    expect(params.p_session_policy).toBe("new");
  });
});
