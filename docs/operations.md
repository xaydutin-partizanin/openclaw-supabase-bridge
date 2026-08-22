# Operations, views, and upgrade

## Chatter read models

- `v_system_overview`: Gateway/bridge freshness, active agents/sessions/tasks, degraded channels, failing collectors, quota attention, and last sync.
- `v_execution_targets`: agent/runtime/config/placement choices, busy state, tools/skills, exec policy, ACP health, and freshness.
- `v_session_picker`: exact key/ID, active run, parent, safe label, model, paths, token count, policies, activity, and freshness.
- `v_active_work`: active bridge runs, OpenClaw tasks, sessions, and flows.
- `v_provider_status`: availability/auth, configs, quota/balance, latest per-run usage and authority.
- `v_attention_needed`: stale/disconnected/failed work, approvals, capacity, security, ACP, channel, and repeated-error signals.
- `v_bridge_health`: heartbeat, connectivity, listener state, recent operations, reconnects, and per-collector state.
- `v_task_relation_cycles`: detected relation cycles.

Freshness is not a cached green badge. Collectors write `source_observed_at`, `ingested_at`, `last_success_at`, `last_changed_at`, `stale_after`, `freshness`, and a boot ID where applicable. Views call `bridge_effective_freshness` so expired rows appear stale even if no process remained alive to update them.

## Upgrade from v0.1.2

1. Keep the live v0.1.2 package running.
2. Apply `migrations/202608220002_openclaw_control_plane_uplink.sql` to the intended Supabase project.
3. Run `docs/security-advisor-checklist.md`.
4. Build/package v0.2.0 with `npm install`, `npm run validate`, and `npm pack`.
5. Install `npm-pack:.\local-openclaw-supabase-bridge-0.2.0.tgz`, enable the plugin, and restart the Gateway.
6. Verify `openclaw plugins inspect supabase-bridge --runtime --json` and `openclaw channels status --deep`.
7. Query `v_bridge_health`, `v_system_overview`, and `v_execution_targets`; confirm one worker/account.
8. Submit harmless legacy, new, continue, and fork tasks using `docs/task-targeting.md`.

## Recovery

Realtime is notification-only; Postgres claims/leases are durable truth. Reconnect uses bounded exponential delay and triggers reconciliation. Ambiguous active work after a Gateway crash is marked failed, not automatically rerun. Collectors retry with bounded backoff; unsupported collectors stop polling. Stop/disable cleanup unregisters host-owned runtime resources and stops timers/controllers.

## Rollback

Disable/uninstall v0.2.0, reinstall the known v0.1.2 package, and restart OpenClaw. The additive schema may remain: v0.1.2 ignores it. Do not reverse or edit the already-applied v0.1 migration. Database history is intentionally retained unless an operator separately designs a destructive data-retention action.
