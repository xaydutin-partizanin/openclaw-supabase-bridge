import type { TelemetryRow } from "../../types.js";
import { json, observedRow, stableKey, write } from "../collector-utils.js";
import { adaptiveStaleAfterMs } from "../freshness.js";
import { listConfiguredAgents } from "../public-runtime.js";
import type { CollectorContext, CollectorResult, TelemetryCollector } from "../types.js";
import { unsupportedCollectorResult } from "../unsupported.js";

const MINUTE = 60_000;

export const cronCollector: TelemetryCollector = {
  id: "cron",
  domain: "cron",
  intervalMs: 10 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(10 * MINUTE, 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    return unsupportedCollectorResult({
      context,
      domain: "cron-inventory",
      reason: "OpenClaw 2026.7.1-2 exposes cron inventory only through trusted Gateway requests; the public session workflow API can schedule plugin-owned turns but cannot list all jobs.",
      staleAfterMs: this.staleAfterMs,
    });
  },
};

export const projectsCollector: TelemetryCollector = {
  id: "projects",
  domain: "projects-workspaces-worktrees",
  intervalMs: 10 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(10 * MINUTE, 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const projects = new Map<string, TelemetryRow>();
    const workspaces: TelemetryRow[] = [];
    for (const agent of listConfiguredAgents(context.api, context.cfg)) {
      const workspacePath = agent.workspacePath;
      if (!workspacePath) continue;
      const projectKey = stableKey(context.instanceKey, "path", workspacePath);
      projects.set(projectKey, observedRow({
        row: {
          project_key: projectKey,
          instance_key: context.instanceKey,
          name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? agent.id,
          root_path: workspacePath,
          source: "configured_agent_workspace",
          available: true,
          metadata: json({
            runtime: agent.runtimeId,
            worktree_inventory: "unsupported_by_external_plugin_api",
          }),
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
      workspaces.push(observedRow({
        row: {
          workspace_key: stableKey(context.instanceKey, "agent", agent.id),
          instance_key: context.instanceKey,
          project_key: projectKey,
          agent_id: agent.id,
          path: workspacePath,
          kind: "agent",
          available: true,
          metadata: { authority: "runtime.agent.resolveAgentWorkspaceDir" },
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
    }
    const unsupportedWorktrees = {
      ...observedRow({
        row: {
          document_key: stableKey(context.instanceKey, "unsupported", "managed-worktree-inventory"),
          instance_key: context.instanceKey,
          domain: "managed-worktree-inventory",
          authority: "unsupported_by_openclaw_external_plugin_api",
          supported: false,
          document: {
            reason: "Configured project/workspace placement is available, but OpenClaw 2026.7.1-2 has no external-plugin helper for managed worktree inventory.",
          },
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }),
      freshness: "unsupported",
    };
    return {
      authority: "plugin_runtime:agent.resolveAgentWorkspaceDir+config_snapshot (worktrees unsupported)",
      observedAt,
      writes: [
        write("projects", "project_key", [...projects.values()]),
        write("workspaces", "workspace_key", workspaces),
        write("worktrees", "worktree_key", []),
        write("state_documents", "document_key", [unsupportedWorktrees]),
      ],
    };
  },
};

export const nodesCollector: TelemetryCollector = {
  id: "nodes",
  domain: "nodes-devices",
  intervalMs: 5 * MINUTE,
  maxIntervalMs: 30 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(5 * MINUTE, 30 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const nodeResult = await context.api.runtime.nodes.list();
    const nodeRows = nodeResult.nodes.map((node): TelemetryRow => observedRow({
      row: {
        node_key: stableKey(context.instanceKey, node.nodeId),
        instance_key: context.instanceKey,
        node_id: node.nodeId,
        display_name: node.displayName ?? null,
        connected: node.connected ?? false,
        capabilities: json(node.caps ?? []),
        commands: json(node.commands ?? []),
        metadata: {},
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    }));
    return {
      authority: "plugin_runtime:nodes.list (device pairing inventory unsupported)",
      observedAt,
      writes: [write("nodes", "node_key", nodeRows), write("devices", "device_key", [])],
    };
  },
};

export const approvalsSecurityCollector: TelemetryCollector = {
  id: "approvals-security",
  domain: "approvals-security",
  intervalMs: 10 * MINUTE,
  activeIntervalMs: 30_000,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(10 * MINUTE, 60 * MINUTE),
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    return unsupportedCollectorResult({
      context,
      domain: "approvals-and-security-snapshots",
      reason: "OpenClaw 2026.7.1-2 exposes approval and audit snapshots only through trusted Gateway requests. The bridge continues to capture sanitized approval/error lifecycle events incrementally.",
      staleAfterMs: this.staleAfterMs,
    });
  },
};

export const memoryPolicyCollector: TelemetryCollector = {
  id: "memory-policy",
  domain: "memory-policy-documents",
  intervalMs: 60 * MINUTE,
  maxIntervalMs: 4 * 60 * MINUTE,
  staleAfterMs: adaptiveStaleAfterMs(60 * MINUTE, 4 * 60 * MINUTE),
  eventDriven: false,
  async run(context): Promise<CollectorResult> {
    return unsupportedCollectorResult({
      context,
      domain: "memory-health-and-policy-documents",
      reason: "OpenClaw 2026.7.1-2 exposes memory diagnostics and agent policy-file inventory only through trusted Gateway requests; the bridge will not scrape private OpenClaw state files.",
      staleAfterMs: this.staleAfterMs,
    });
  },
};

export const operationCollectors: TelemetryCollector[] = [
  cronCollector,
  projectsCollector,
  nodesCollector,
  approvalsSecurityCollector,
  memoryPolicyCollector,
];
