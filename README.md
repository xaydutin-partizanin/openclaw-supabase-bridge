# OpenClaw Supabase Bridge

`supabase-bridge` is a small external OpenClaw channel plugin that treats Supabase as a durable task mailbox and run ledger. It does not patch OpenClaw core and it does not expose Supabase as an agent tool.

```text
ChatGPT -> Supabase tasks -> OpenClaw channel -> native/ACP agent
        <- reports/runs/events/quota <- OpenClaw agent events
```

OpenClaw remains the orchestrator. Supabase stores only bridge protocol state; RGAT/CIC application state does not belong here.

## Database objects

Apply [`migrations/202608220001_supabase_bridge.sql`](migrations/202608220001_supabase_bridge.sql) to the hosted project before enabling the channel. It creates:

- `providers`: discovered provider-level capability documents.
- `agent_configs`: one row per selectable agent/model/effort or ACP configuration.
- `tasks`: simple inbound task mailbox with leases.
- `runs`: requested versus actual execution records.
- `reports`: one concise final report per run.
- `events`: sanitized chronological operational events.
- `quota_status`: latest honest provider quota/balance buckets.
- RPCs for atomic claim, lease renewal, reconciliation, inventory refresh, run start, and idempotent terminal writes.
- RLS on every bridge table and Realtime publication for `tasks`.

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

If `requested_config` is missing, unknown, or unavailable, the plugin selects the one available default and records `fallback_used` plus `fallback_reason`. A task fails before execution only when no valid default exists.

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

The channel uses OpenClaw’s public `runEmbeddedAgent` runtime helper. This directly routes native choices to the selected provider/model/effort and ACP choices to the configured ACP agent, avoiding an unnecessary parent-model call. Each task gets an isolated OpenClaw session key.

The final visible assistant response becomes `reports.report_text`. Structured metadata includes status, selected config, duration, usage, fallback attempts, and accepted child sessions when OpenClaw exposes them. Reports do not contain the full transcript.

## Event logging

The plugin subscribes to OpenClaw’s public agent event bus and persists only runs correlated to Supabase-originated task sessions. Parent and publicly announced child session/run identifiers are associated with the same bridge run.

Persisted streams include lifecycle, tool, assistant, error, item, plan, approval, command output, patch, compaction, thinking, ACP, and custom events. Secret-shaped fields, bearer values, cookies, credential objects, environment dumps, and binary payloads are redacted. Large payloads are bounded and carry `truncated` plus `original_size` metadata. The local OpenClaw transcript remains the deep forensic source.

Set `eventLoggingEnabled` to `false` to retain only task/run/report state.

## Quota behavior

Quota refresh runs at startup, periodically (15 minutes by default), after every terminal task, and best-effort at shutdown.

- OpenAI: OpenClaw’s public Codex/OpenAI usage adapter is queried. Provider-reported used percentages are represented as honest percentage buckets with reset times.
- DeepSeek: OpenClaw’s public DeepSeek usage adapter is queried. Balances/budgets are represented in their provider units.
- Cursor ACP: remaining allowance is `UNSUPPORTED` unless a future authoritative provider adapter becomes available. Generic OpenClaw token counters are not treated as Cursor quota.
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
          quotaRefreshIntervalMinutes: 15,
          eventLoggingEnabled: true,
          eventMaxPayloadBytes: 65536
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
openclaw plugins install npm-pack:.\local-openclaw-supabase-bridge-0.1.2.tgz
openclaw plugins enable supabase-bridge
```

`npm-pack:` installs runtime dependencies into OpenClaw’s managed per-plugin project and records upgrade-safe provenance. Editable source remains outside OpenClaw core.

After applying the migration and configuring the SecretRef, restart and verify:

```powershell
openclaw gateway restart
openclaw plugins inspect supabase-bridge --runtime --json
openclaw channels status --deep
```

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

Tests cover config fallback, claims/lease expiry, duplicate Realtime notifications, reconnect reconciliation, parent/child event correlation, unrelated-session filtering, duplicate event keys, secret sanitization, payload bounds, idempotent completion/failure, quota bucket semantics, and repeated cleanup.

## Troubleshooting

- **Plugin loads but channel is inactive:** both plugin config `enabled` and `channels.supabase-bridge.enabled` must be true.
- **SecretRef did not resolve:** verify the provider path/ACL and run `openclaw secrets audit --check` without printing the secret.
- **Realtime connects but tasks do not run:** verify the migration and `supabase_realtime` publication membership, then inspect expired leases and Gateway logs.
- **Task uses the default unexpectedly:** inspect `runs.fallback_reason` and the current `agent_configs` row.
- **Cursor model looks like OpenAI in generic session UI:** treat the Cursor ACP harness/dashboard as authoritative; this bridge intentionally stores the internal Cursor model as unknown.
- **Quota is unsupported:** this is expected when no authoritative provider usage adapter exists.

## Restart and uninstall

Gateway/plugin stop removes the Realtime channel, event subscription ownership, timers, and buffered resources. Repeated stop is idempotent.

To remove the runtime integration while retaining database history:

```powershell
openclaw plugins disable supabase-bridge
openclaw plugins uninstall supabase-bridge
openclaw gateway restart
```

Remove `plugins.entries.supabase-bridge`, `channels.supabase-bridge`, and the SecretRef provider only after confirming no other config uses it. Database tables are intentionally not dropped by uninstall.
