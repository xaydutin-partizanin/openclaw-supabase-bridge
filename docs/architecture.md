# Architecture and boundaries

```text
Chatter -> Supabase tasks/task_targets -> one bridge controller/account
        -> OpenClaw public runtime -> one primary agent execution
        <- reports/runs/events + read-only control-plane projection
```

OpenClaw is authoritative for runtime state. Supabase provides a durable mailbox, historical run truth, and a query-friendly projection. There is no second local job database and no OpenClaw core patch.

The package exposes two related UI surfaces, not two workers:

- **Supabase Control Plane Bridge** is the external plugin/capability entry.
- **Supabase Task Mailbox** is its channel/account entry.

`src/runtime-registry.ts` keeps controllers in a `Map` keyed by account ID. Starting the same account stops and replaces its prior controller. The plugin registers one host-owned agent-event subscription; account controllers receive events through that owner. Runtime lifecycle cleanup stops all controllers, timers, listeners, and buffers.

## Runtime modules

- `index.ts`: plugin registration, public observation hooks, one event subscription, cleanup.
- `src/runtime-registry.ts`: single controller owner per account.
- `src/controller.ts`: durable task lifecycle and integration composition.
- `src/task-targeting.ts`: exact instance/agent/session/placement validation.
- `src/telemetry/manager.ts`: collector scheduling, freshness, heartbeat, hooks, usage, and bounded operational events.
- `src/telemetry/collectors/core.ts`: Gateway, agents, sessions, tasks/flows, channels, plugins, safe config shape.
- `src/telemetry/collectors/capabilities.ts`: models/auth/ACP, tools, skills, MCP and exec policy.
- `src/telemetry/collectors/operations.ts`: cron, placement, nodes/devices, approvals/audit, memory and policy metadata.
- `src/database.ts`: documented Supabase tables/RPCs only.

## Control boundary

The only remote write capability is task submission plus its exact target and lightweight task relations. Approvals, security, config, plugins, Gateway lifecycle, sessions, channels, nodes, memory, cron, and policies are read-only. No generic command table exists.

Agents never receive the Supabase credential. The Gateway resolves a backend-only OpenClaw SecretRef and creates the Supabase client inside the plugin controller. Child agents receive a prompt and OpenClaw session/runtime fields only.

## Data boundary

Mirrored data is operational metadata: stable IDs, status, safe labels/titles, runtime/provider/model references, placement paths, capability names, counts, timestamps, freshness, and bounded errors. Prompts, general replies/transcripts, memory text, tool arguments/results, command bodies/output dumps, environment values, auth material, cookies, browser contents/history, screenshots, device keys, and IP addresses are excluded.

High-volume diagnostics remain local or belong in OpenTelemetry/Loki/Tempo. Supabase gets low-volume structured events and hourly error rollups.
