import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../migrations/202608220002_openclaw_control_plane_uplink.sql", import.meta.url));
const originalPath = fileURLToPath(new URL("../migrations/202608220001_supabase_bridge.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

describe("additive control-plane migration contract", () => {
  it("keeps deployment history additive", () => {
    expect(sql).toContain("Migration 202608220001 is already deployed and is intentionally not rewritten");
    expect(readFileSync(originalPath, "utf8")).not.toContain("openclaw_control_plane_uplink");
  });

  it.each([
    "openclaw_instances", "bridge_workers", "telemetry_collectors", "gateway_status", "openclaw_agents",
    "models", "model_auth_status", "model_run_usage", "acp_backends", "agent_harnesses", "openclaw_sessions",
    "session_active_runs", "session_relations", "openclaw_tasks", "task_flows", "cron_jobs", "channel_accounts",
    "openclaw_plugins", "plugin_hooks", "tools", "skills", "mcp_servers", "execution_policies", "approvals",
    "security_findings", "memory_status", "policy_documents", "projects", "workspaces", "worktrees", "nodes",
    "devices", "browser_profiles", "operational_events", "error_rollups", "state_documents", "task_targets", "task_relations",
  ])("defines normalized table %s", (table) => {
    expect(sql).toMatch(new RegExp(`create table if not exists public\\.${table}\\s*\\(`, "i"));
  });

  it.each(["v_system_overview", "v_execution_targets", "v_session_picker", "v_active_work", "v_provider_status", "v_attention_needed", "v_bridge_health", "v_task_relation_cycles"])("defines service-role read model %s", (view) => {
    expect(sql).toMatch(new RegExp(`create or replace view public\\.${view}`, "i"));
    expect(sql).toMatch(new RegExp(`grant select[\\s\\S]*public\\.${view}`, "i"));
  });

  it("computes staleness at query time and protects new tables with RLS", () => {
    expect(sql).toContain("bridge_effective_freshness");
    expect(sql).toContain("p_stale_after <= now()");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on public.%I from anon, authenticated");
    expect(sql).not.toMatch(/create policy[\s\S]+\bto\s+(anon|authenticated)\b/i);
  });

  it("adds only the task-target write surface and records historical target truth", () => {
    expect(sql).toContain("session_policy in ('new', 'continue', 'fork')");
    expect(sql).toContain("busy_policy in ('queue', 'reject')");
    expect(sql).toContain("requested_instance_key");
    expect(sql).toContain("actual_session_id");
    expect(sql).toContain("submit_bridge_task_v2");
    expect(sql).toContain("Atomic submission avoids a Realtime race");
    expect(sql).not.toMatch(/create table if not exists public\.commands/i);
  });

  it("grants the exact start-run overload declared by the migration", () => {
    const declaration = /create or replace function public\.start_bridge_run_v2\(([\s\S]*?)\)\s*returns setof/i.exec(sql)?.[1];
    const grant = /grant execute on function public\.start_bridge_run_v2\(([^)]*)\)/i.exec(sql)?.[1];
    expect(declaration).toBeTruthy();
    expect(grant).toBeTruthy();
    const declaredTypes = declaration!.split(",").map((item) => item.trim().split(/\s+/)[1]);
    const grantedTypes = grant!.split(",").map((item) => item.trim());
    expect(grantedTypes).toEqual(declaredTypes);
  });
});
