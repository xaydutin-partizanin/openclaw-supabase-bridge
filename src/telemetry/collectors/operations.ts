import { asBoolean, asRecord, asString } from "../../object-utils.js";
import type { TelemetryRow } from "../../types.js";
import { json, nullableString, observedRow, rows, safeMetadata, stableHash, stableKey, write } from "../collector-utils.js";
import type { CollectorContext, CollectorResult, TelemetryCollector } from "../types.js";

const MINUTE = 60_000;

async function request(context: CollectorContext, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return context.api.runtime.gateway.request(method, params);
}

export const cronCollector: TelemetryCollector = {
  id: "cron",
  domain: "cron",
  intervalMs: 10 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: 30 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const result = asRecord(await request(context, "cron.list", { includeDisabled: true }));
    const observedAt = context.now.toISOString();
    const jobs = (Array.isArray(result.jobs) ? result.jobs : Array.isArray(result) ? result : []).map(asRecord);
    const mapped = jobs.flatMap((job): TelemetryRow[] => {
      const id = asString(job.id);
      if (!id) return [];
      const schedule = asRecord(job.schedule);
      const state = asRecord(job.state);
      return [observedRow({
        row: {
          cron_key: stableKey(context.instanceKey, id),
          instance_key: context.instanceKey,
          cron_id: id,
          agent_id: nullableString(job.agentId),
          name: nullableString(job.name),
          description: nullableString(job.description),
          enabled: job.enabled === undefined ? true : asBoolean(job.enabled, false),
          schedule_kind: nullableString(schedule.kind),
          schedule_expression: nullableString(schedule.expr),
          timezone: nullableString(schedule.tz),
          session_target: nullableString(job.sessionTarget),
          wake_mode: nullableString(job.wakeMode),
          next_run_at: typeof state.nextRunAtMs === "number" ? new Date(state.nextRunAtMs).toISOString() : null,
          last_run_at: typeof state.lastRunAtMs === "number" ? new Date(state.lastRunAtMs).toISOString() : null,
          last_run_status: nullableString(state.lastRunStatus),
          last_error: nullableString(state.lastError),
          payload_body_excluded: true,
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
    });
    return { authority: "gateway_rpc:cron.list", observedAt, writes: [write("cron_jobs", "cron_key", mapped)] };
  },
};

export const projectsCollector: TelemetryCollector = {
  id: "projects",
  domain: "projects-workspaces-worktrees",
  intervalMs: 10 * MINUTE,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: 30 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const [agentsValue, worktreesValue] = await Promise.all([
      request(context, "agents.list"),
      request(context, "worktrees.list"),
    ]);
    const observedAt = context.now.toISOString();
    const projects = new Map<string, TelemetryRow>();
    const workspaces: TelemetryRow[] = [];
    for (const agent of rows(asRecord(agentsValue), "agents")) {
      const agentId = asString(agent.id);
      const workspacePath = asString(agent.workspace);
      if (!agentId || !workspacePath) continue;
      const projectKey = stableKey(context.instanceKey, "path", workspacePath);
      projects.set(projectKey, observedRow({
        row: {
          project_key: projectKey,
          instance_key: context.instanceKey,
          name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? agentId,
          root_path: workspacePath,
          source: "agent_workspace",
          available: true,
          metadata: json({ git: agent.workspaceGit }),
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
      workspaces.push(observedRow({
        row: {
          workspace_key: stableKey(context.instanceKey, "agent", agentId),
          instance_key: context.instanceKey,
          project_key: projectKey,
          agent_id: agentId,
          path: workspacePath,
          kind: "agent",
          available: true,
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
    }
    const worktreeRows = rows(asRecord(worktreesValue), "worktrees").flatMap((worktree): TelemetryRow[] => {
      const id = asString(worktree.id);
      const worktreePath = asString(worktree.path);
      if (!id || !worktreePath) return [];
      const repoRoot = asString(worktree.repoRoot);
      const projectKey = repoRoot ? stableKey(context.instanceKey, "path", repoRoot) : null;
      if (repoRoot && projectKey && !projects.has(projectKey)) projects.set(projectKey, observedRow({
        row: {
          project_key: projectKey,
          instance_key: context.instanceKey,
          name: repoRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? id,
          root_path: repoRoot,
          source: "managed_worktree",
          available: true,
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }));
      return [observedRow({
        row: {
          worktree_key: stableKey(context.instanceKey, id),
          instance_key: context.instanceKey,
          worktree_id: id,
          project_key: projectKey,
          owner_kind: nullableString(worktree.ownerKind),
          owner_id: nullableString(worktree.ownerId),
          path: worktreePath,
          branch: nullableString(worktree.branch),
          available: true,
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
    });
    return {
      authority: "gateway_rpc:agents.list+worktrees.list",
      observedAt,
      writes: [
        write("projects", "project_key", [...projects.values()]),
        write("workspaces", "workspace_key", workspaces),
        write("worktrees", "worktree_key", worktreeRows),
      ],
    };
  },
};

export const nodesCollector: TelemetryCollector = {
  id: "nodes",
  domain: "nodes-devices",
  intervalMs: 5 * MINUTE,
  maxIntervalMs: 30 * MINUTE,
  staleAfterMs: 15 * MINUTE,
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
    let deviceRows: TelemetryRow[] = [];
    try {
      const deviceResult = asRecord(await request(context, "device.pair.list"));
      deviceRows = rows(deviceResult, "devices").flatMap((device): TelemetryRow[] => {
        const id = asString(device.id) ?? asString(device.deviceId);
        if (!id) return [];
        return [observedRow({
          row: {
            device_key: stableKey(context.instanceKey, id),
            instance_key: context.instanceKey,
            device_id: id,
            display_name: nullableString(device.displayName) ?? nullableString(device.name),
            platform: nullableString(device.platform),
            paired: true,
            connected: asBoolean(device.connected, false),
            scopes: json(device.scopes ?? []),
            token_material_excluded: true,
            metadata: {},
          },
          observedAt,
          staleAfterMs: this.staleAfterMs,
          bootId: context.bootId,
        })];
      });
    } catch {
      // Device pairing metadata can be scope-restricted; node inventory remains authoritative.
    }
    return {
      authority: "plugin_runtime:nodes.list + gateway_rpc:device.pair.list",
      observedAt,
      writes: [write("nodes", "node_key", nodeRows), write("devices", "device_key", deviceRows)],
    };
  },
};

export const approvalsSecurityCollector: TelemetryCollector = {
  id: "approvals-security",
  domain: "approvals-security",
  intervalMs: 10 * MINUTE,
  activeIntervalMs: 30_000,
  maxIntervalMs: 60 * MINUTE,
  staleAfterMs: 30 * MINUTE,
  eventDriven: true,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    const [approvalValue, auditValue] = await Promise.all([
      request(context, "exec.approval.list"),
      request(context, "audit.list", { limit: 100 }),
    ]);
    const approvalsArray = Array.isArray(approvalValue) ? approvalValue : rows(asRecord(approvalValue), "approvals");
    const approvalRows = approvalsArray.map(asRecord).flatMap((approval): TelemetryRow[] => {
      const id = asString(approval.id) ?? asString(approval.approvalId);
      if (!id) return [];
      return [observedRow({
        row: {
          approval_key: stableKey(context.instanceKey, id),
          instance_key: context.instanceKey,
          approval_id: id,
          kind: nullableString(approval.kind) ?? "exec",
          status: nullableString(approval.status) ?? "pending",
          title: nullableString(approval.title),
          agent_id: nullableString(approval.agentId),
          session_key: nullableString(approval.sessionKey),
          run_id: nullableString(approval.runId),
          requested_at: typeof approval.requestedAt === "number" ? new Date(approval.requestedAt).toISOString() : null,
          resolved_at: typeof approval.resolvedAt === "number" ? new Date(approval.resolvedAt).toISOString() : null,
          command_body_excluded: true,
          metadata: {},
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
    });
    const audit = asRecord(auditValue);
    const findings = (Array.isArray(audit.events) ? audit.events : Array.isArray(audit.findings) ? audit.findings : []).map(asRecord);
    const findingRows = findings.flatMap((finding, index): TelemetryRow[] => {
      const code = asString(finding.code) ?? asString(finding.type) ?? `audit-${index}`;
      return [observedRow({
        row: {
          finding_key: stableHash(context.instanceKey, code, asString(finding.id) ?? index),
          instance_key: context.instanceKey,
          finding_id: nullableString(finding.id),
          code,
          severity: nullableString(finding.severity) ?? "info",
          status: nullableString(finding.status) ?? "observed",
          title: nullableString(finding.title) ?? nullableString(finding.message),
          source: "gateway_audit",
          sensitive_detail_excluded: true,
          metadata: safeMetadata({ category: finding.category, subject: finding.subject }, 4_096),
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      })];
    });
    return {
      authority: "gateway_rpc:exec.approval.list+audit.list",
      observedAt,
      writes: [write("approvals", "approval_key", approvalRows), write("security_findings", "finding_key", findingRows)],
    };
  },
};

export const memoryPolicyCollector: TelemetryCollector = {
  id: "memory-policy",
  domain: "memory-policy-documents",
  intervalMs: 60 * MINUTE,
  maxIntervalMs: 4 * 60 * MINUTE,
  staleAfterMs: 2 * 60 * MINUTE,
  eventDriven: false,
  async run(context): Promise<CollectorResult> {
    const observedAt = context.now.toISOString();
    let memoryValue: unknown = {};
    try {
      memoryValue = await request(context, "doctor.memory.status");
    } catch (error) {
      memoryValue = { unsupported: true, error: error instanceof Error ? error.message : String(error) };
    }
    const memory = asRecord(memoryValue);
    const embedding = asRecord(memory.embedding);
    const dreaming = asRecord(memory.dreaming);
    const memoryRow = observedRow({
      row: {
        memory_key: stableKey(context.instanceKey, asString(memory.agentId) ?? "main"),
        instance_key: context.instanceKey,
        agent_id: nullableString(memory.agentId) ?? "main",
        provider: nullableString(memory.provider),
        embedding_ready: asBoolean(embedding.ok, false),
        embedding_checked: asBoolean(embedding.checked, false),
        status: asBoolean(embedding.ok, false) ? "healthy" : "not_ready",
        dreaming_enabled: asBoolean(dreaming.enabled, false),
        short_term_count: typeof dreaming.shortTermCount === "number" ? dreaming.shortTermCount : null,
        signal_count: typeof dreaming.totalSignalCount === "number" ? dreaming.totalSignalCount : null,
        memory_contents_excluded: true,
        last_error: nullableString(embedding.error),
        metadata: {},
      },
      observedAt,
      staleAfterMs: this.staleAfterMs,
      bootId: context.bootId,
    });

    const agents = rows(asRecord(await request(context, "agents.list")), "agents");
    const documentRows: TelemetryRow[] = [];
    for (const agent of agents) {
      const agentId = asString(agent.id);
      if (!agentId) continue;
      try {
        const files = asRecord(await request(context, "agents.files.list", { agentId }));
        for (const file of rows(files, "files")) {
          const name = asString(file.name) ?? asString(file.path);
          if (!name || !/^(AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY|MEMORY)\.md$/i.test(name.split(/[\\/]/).at(-1) ?? "")) continue;
          documentRows.push(observedRow({
            row: {
              document_key: stableKey(context.instanceKey, agentId, name),
              instance_key: context.instanceKey,
              agent_id: agentId,
              document_name: name.split(/[\\/]/).at(-1) ?? name,
              path: nullableString(file.path) ?? name,
              exists: true,
              size_bytes: typeof file.size === "number" ? file.size : null,
              modified_at: typeof file.mtimeMs === "number" ? new Date(file.mtimeMs).toISOString() : null,
              contents_excluded: true,
              metadata: {},
            },
            observedAt,
            staleAfterMs: this.staleAfterMs,
            bootId: context.bootId,
          }));
        }
      } catch {
        // File metadata is optional and can be scope-restricted.
      }
    }

    const unsupportedRows: TelemetryRow[] = [
      ["browser-profiles", "browser_profiles", "No public browser profile inventory RPC is exposed by OpenClaw 2026.7.1-2"],
      ["global-security-audit", "security_findings", "Gateway audit events are available; the full CLI security audit is not exposed to third-party plugins"],
    ].map(([documentKey, domain, reason]) => ({
      ...observedRow({
        row: {
        document_key: stableKey(context.instanceKey, documentKey),
        instance_key: context.instanceKey,
        domain,
        authority: "unsupported",
        supported: false,
        document: json({ reason }),
        },
        observedAt,
        staleAfterMs: this.staleAfterMs,
        bootId: context.bootId,
      }),
      freshness: "unsupported",
    }));

    return {
      authority: "gateway_rpc:doctor.memory.status+agents.files.list",
      observedAt,
      writes: [
        write("memory_status", "memory_key", [memoryRow]),
        write("policy_documents", "document_key", documentRows),
        write("state_documents", "document_key", unsupportedRows),
      ],
    };
  },
};

export const operationCollectors: TelemetryCollector[] = [
  cronCollector,
  projectsCollector,
  nodesCollector,
  approvalsSecurityCollector,
  memoryPolicyCollector,
];
