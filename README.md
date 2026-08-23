# OpenClaw Supabase Bridge

`supabase-bridge` is an external OpenClaw plugin that combines a durable task mailbox/run ledger with a low-volume, read-only operational control-plane uplink. It does not patch OpenClaw core and does not expose Supabase credentials or a Supabase tool to agents.

```text
ChatGPT -> Supabase tasks -> OpenClaw channel -> native/ACP agent
        <- reports/runs/events/control-plane views <- OpenClaw public APIs and hooks
```

OpenClaw remains authoritative and remains the orchestrator. Supabase is a time-aware projection, not a second scheduler, transcript store, raw-log warehouse, or generic admin console. See [architecture](docs/architecture.md), [task targeting](docs/task-targeting.md), [operations](docs/operations.md), and the [capability matrix](docs/telemetry-capability-matrix.json).

## Database objects

For a new deployment apply both migrations in order. Existing v0.1.x installations must leave `202608220001_supabase_bridge.sql` unchanged and apply only [`migrations/202608220002_openclaw_control_plane_uplink.sql`](migrations/202608220002_openclaw_control_plane_uplink.sql) before installing v0.2.x.

The first migration creates:

- `providers`: discovered provider-level capability documents.
- `agent_configs`: one row per selectable agent/model/effort or ACP configuration.
- `tasks`: simple inbound task mailbox with leases.
- `runs`: requested versus actual execution records.
- `reports`: one concise final report per run.
- `events`: sanitized chronological operational events.
- `quota_status`: latest honest provider quota/balance buckets.
- RPCs for atomic claim, lease renewal, reconciliation, inventory refresh, run start, and idempotent terminal writes.
- RLS on every bridge table and Realtime publication for `tasks`.

The additive v0.2 migration adds exact task targeting, requested-versus-actual run placement, normalized OpenClaw control-plane tables, bridge/collector health, bounded operational error rollups, and these stable Chatter views:

- `v_system_overview`
- `v_execution_targets`
- `v_session_picker`
- `v_active_work`
- `v_provider_status`
- `v_attention_needed`
- `v_bridge_health`
- `v_task_relation_cycles`

The migration deliberately grants no anonymous or broad authenticated policy. It initially grants the operational functions/tables to Supabase `service_role`. Replace that broad deployment credential with a dedicated least-privilege role/key when the project’s auth design is settled.

## Task format

The normal sender supplies only a prompt and an optional stable `agent_configs.config_key`:

```json
{
  "prompt": "Inspect the repository and report the current test failures.",
  "requested_config": null
}
```

Explicit configuration example (use a key actually present in `agent_configs`):

```json
{
  "prompt": "Run a read-only repository health check and report the result.",
  "requested_config": "cursor:acp:cursor:auto"
}
```

Do not place secrets in `prompt`, `metadata`, or any other task field.

If a legacy task has no `task_targets` row, the old fallback behavior is unchanged: a missing, unknown, or unavailable `requested_config` falls back to the available default and records the reason. An explicitly targeted task never silently changes agent, session, instance, workspace, worktree, or requested configuration.

For targeted work, use the atomic `submit_bridge_task_v2` RPC so Realtime cannot observe the task before its target exists. On external-plugin installs of OpenClaw 2026.7.1-2, `new` and `continue` are supported; `fork` is accepted by the schema but fails explicitly as `session_fork_unsupported` because transcript forking has no public external-plugin API. `busy_policy` supports `queue` and `reject`. Exact examples are in [task targeting](docs/task-targeting.md).

## Provider/config discovery

At startup and before stale inventory is used, the plugin reads OpenClaw’s active runtime configuration and:

- enumerates configured native agents and model refs;
- asks OpenClaw for each model’s selectable thinking/effort policy;
- probes provider auth availability without persisting credentials;
- enumerates configured ACP agents such as Cursor and records harness/backend/mode metadata;
- marks Cursor’s internally selected Auto model as non-authoritative rather than copying a generic OpenClaw label;
- UPSERTs deterministic config keys and marks disappeared configurations unavailable.

The plugin does not hard-code the machine’s provider inventory.

## Execution and reports

The channel uses OpenClaw’s public `runEmbeddedAgent` runtime helper. Native choices route to the selected provider/model/effort and ACP choices route to the configured ACP agent. Legacy and `new` tasks get a clean bridge-owned session. `continue` uses the exact key and durable ID after revalidation through `runtime.agent.session.listSessionEntries`. OpenClaw 2026.7.1-2 restricts `sessions.create` and transcript forking to trusted Gateway clients, so an external bridge fails `fork` explicitly rather than bypassing trust or copying transcript files.

The final visible assistant response becomes `reports.report_text`. Structured metadata includes status, selected config, duration, usage, fallback attempts, and accepted child sessions when OpenClaw exposes them. Reports do not contain the full transcript.

## Event logging

The plugin subscribes to OpenClaw’s public agent event bus and persists only runs correlated to Supabase-originated task sessions. Parent and publicly announced child session/run identifiers are associated with the same bridge run.

The subscription observes the host event surface for correlation, but persists only bounded operational projections of lifecycle, tool completion, error, item/plan status, approval, compaction, and ACP events. Assistant/thinking deltas, command output, patches, tool arguments/results, and content bodies are discarded. Secret-shaped fields, bearer values, cookies, credential objects, environment dumps, and binary payloads are redacted. The local OpenClaw transcript remains the deep forensic source.

Set `eventLoggingEnabled` to `false` to retain only task/run/report state.

## Control-plane telemetry

The v0.2 lifecycle manager owns independent collectors for Gateway, agents, sessions, OpenClaw tasks/flows, channels, plugins/hooks, models/auth/ACP, tools, skills, execution policy/MCP metadata, cron, projects/workspaces, nodes/devices, approvals/audit, memory health, and policy-document metadata. External plugins use only supported in-process runtime/config/event surfaces. OpenClaw 2026.7.1-2 does not expose global tool/skill/cron/approval/audit/memory-policy snapshots, managed-worktree inventory, or device-pairing inventory to external plugins; those limitations are written as explicit `unsupported` state documents and never retried through forbidden Gateway RPCs.

Every current-state row carries source/ingestion/success/change timestamps, a stale deadline, freshness, and a boot identifier where transient state is involved. Views recompute effective staleness at query time. General prompts, replies, transcripts, memory content, cron payloads, approval commands, browser history, IP addresses, cookies, tokens, environment values, and private key material are excluded.

## Quota behavior

Quota refresh runs at startup, periodically (15 minutes by default), after every terminal task, and best-effort at shutdown.

- OpenAI: OpenClaw’s public Codex/OpenAI usage adapter is queried. Provider-reported used percentages are represented as honest percentage buckets with reset times.
- DeepSeek: OpenClaw’s public DeepSeek usage adapter is queried. Balances/budgets are represented in their provider units.
- Cursor: when a local Cursor login or optional `cursorUserApiKey` SecretRef is available, the bridge calls Cursor’s authenticated internal DashboardService (`GetCurrentPeriodUsage` / `GetPlanInfo`) and stores Cursor Models / Other Models / total percent windows plus included allowance cents. Source is recorded as `cursor_internal_api` (undocumented provider interface — not a public billing API). Optional User API Keys are exchanged via `POST /auth/exchange_user_api_key` with `Authorization: Bearer <key>` and body `{}` (not a JSON `userApiKey` field). Generic ACP/session token counters are never treated as Cursor quota. If no auth source exists, Cursor remains `unsupported`.
- Unknown providers: `UNSUPPORTED` or `UNKNOWN`; no allowance is invented.

Quota errors never stop task execution.

## Secure configuration

Do not put the Supabase credential in Gateway environment variables: ACP/Cursor subprocesses can inherit environment variables. Use an OpenClaw file or exec `SecretRef` instead.

Example single-value file provider (paths are illustrative):

```json5
{
  secrets: {
    providers: {
      supabasebridge: {
        source: "file",
        path: "C:\\Users\\<user>\\.openclaw-secrets\\supabase-bridge.key",
        mode: "singleValue"
      }
    }
  },
  plugins: {
    entries: {
      "supabase-bridge": {
        enabled: true,
        config: {
          enabled: true,
          supabaseUrl: "https://<project-ref>.supabase.co",
          supabaseCredential: {
            source: "file",
            provider: "supabasebridge",
            id: "value"
          },
          // Optional. Preferred for long-running daemons when available.
          // cursorUserApiKey: { source: "file", provider: "cursoruser", id: "value" },
          quotaRefreshIntervalMinutes: 15,
          eventLoggingEnabled: true,
          eventMaxPayloadBytes: 65536,
          telemetryEnabled: true,
          telemetryHeartbeatSeconds: 60,
          instanceKey: "openclaw:<stable-host-key>"
        }
      }
    }
  },
  channels: {
    "supabase-bridge": { enabled: true }
  }
}
```

Store the file outside every agent workspace and restrict its ACL to the Gateway operator. A SecretRef avoids automatic credential inheritance and persistence in `openclaw.json`; it is not process isolation against arbitrary same-user file access. An exec provider backed by an OS credential store is stronger when available.

The plugin keeps the resolved credential only in its Supabase client. It never adds it to agent prompts, tools, task metadata, events, reports, or subprocess environments.

## Install

Build and package from the stable user-owned source directory:

```powershell
npm install
npm run validate
npm pack
openclaw plugins install npm-pack:.\local-openclaw-supabase-bridge-0.2.3.tgz
openclaw plugins enable supabase-bridge
```

`npm-pack:` installs runtime dependencies into OpenClaw’s managed per-plugin project and records upgrade-safe provenance. Editable source remains outside OpenClaw core.

Do not install v0.2.x before the additive migration is applied. After applying it and configuring the SecretRef, upgrade, restart, and verify:

```powershell
openclaw gateway restart
openclaw plugins inspect supabase-bridge --runtime --json
openclaw channels status --deep
```

Then query `v_bridge_health`, `v_system_overview`, and `v_execution_targets`. Run the [security-advisor checklist](docs/security-advisor-checklist.md) after every schema deployment.

## Reconnect and recovery

Realtime is notification only; Postgres is durable truth. The plugin:

- atomically claims tasks with a worker id and lease;
- uses OpenClaw’s durable channel ingress queue when the runtime grants it; ordinary external installs fall back to an in-memory notification queue while Supabase claims, leases, and reconciliation remain the durable authority;
- renews active leases;
- reconciles pending and expired tasks at startup, after reconnect, and periodically;
- uses bounded exponential Realtime reconnect delays;
- does not rerun an expired `running` task after an ambiguous Gateway crash;
- records the ambiguous recovery as failed so destructive work is never blindly duplicated;
- writes task/run/report terminal state through idempotent RPCs.

## Tests

```powershell
npm run typecheck
npm test
npm run build
npm run validate
```

Tests cover the v0.1 behavior plus exact new/continue targeting, explicit unsupported fork/worktree behavior, stale/mismatched targets, busy policies, placement validation, historical run truth, safe session/task mirrors, freshness, adaptive collection, self-health, per-run usage authority, migration/view shape, and duplicate controller ownership.

## Troubleshooting

- **Plugin loads but channel is inactive:** both plugin config `enabled` and `channels.supabase-bridge.enabled` must be true.
- **SecretRef did not resolve:** verify the provider path/ACL and run `openclaw secrets audit --check` without printing the secret.
- **Realtime connects but tasks do not run:** verify the migration and `supabase_realtime` publication membership, then inspect expired leases and Gateway logs.
- **Task uses the default unexpectedly:** inspect `runs.fallback_reason` and the current `agent_configs` row.
- **Cursor model looks like OpenAI in generic session UI:** treat the Cursor ACP harness/dashboard as authoritative; this bridge intentionally stores the internal Cursor model as unknown.
- **Quota is unsupported:** expected for providers without an adapter, or for Cursor when neither a local Cursor login nor `cursorUserApiKey` is available.
- **Cursor quota source:** `cursor_internal_api` is an authenticated undocumented Cursor interface. Treat schema changes as hard failures that surface as `error`/`unsupported`, never as invented remaining allowance.
- **v0.2 collector errors mention missing tables:** the additive migration was not applied; keep or restore the v0.1.2 package until it is.
- **Exact target failed:** inspect the safe error code; the bridge intentionally refuses to retarget stale or mismatched work.

## Restart and uninstall

Gateway/plugin stop removes the Realtime channel, event subscription ownership, timers, and buffered resources. Repeated stop is idempotent.

To remove the runtime integration while retaining database history:

```powershell
openclaw plugins disable supabase-bridge
openclaw plugins uninstall supabase-bridge
openclaw gateway restart
```

Remove `plugins.entries.supabase-bridge`, `channels.supabase-bridge`, and the SecretRef provider only after confirming no other config uses it. Database tables are intentionally not dropped by uninstall.
