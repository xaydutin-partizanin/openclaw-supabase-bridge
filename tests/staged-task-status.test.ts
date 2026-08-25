import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../migrations/202608250001_staged_task_status.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

describe("staged task status migration contract", () => {
  it("keeps prior migrations untouched and documents staged as non-executable", () => {
    expect(sql).toContain("Migration 202608220001 / 202608220002 remain deployed");
    expect(sql).toContain("'staged'");
    expect(sql).toContain("release_staged_bridge_task");
    expect(sql).toContain("p_initial_status");
  });

  it("keeps claim and reconciliation pending-only", () => {
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).toContain("list_bridge_reconciliation_tasks");
    expect(sql).toContain("claim_bridge_task");
    expect(sql).not.toMatch(/status = 'staged'[\s\S]{0,80}claimed/);
  });

  it("rejects releasing non-staged statuses", () => {
    expect(sql).toContain("only staged tasks can be released to pending");
    expect(sql).toContain("for update");
  });

  it("grants the extended submit signature and release RPC to service_role only", () => {
    expect(sql).toContain("grant execute on function public.submit_bridge_task_v2(uuid, text, text, jsonb, jsonb, text) to service_role");
    expect(sql).toContain("grant execute on function public.release_staged_bridge_task(uuid) to service_role");
    expect(sql).toContain("revoke all on function public.release_staged_bridge_task(uuid) from public, anon, authenticated");
  });
});
