# Task and session targeting

Use `submit_bridge_task_v2` for targeted work. It inserts the `tasks` and optional `task_targets` rows atomically, avoiding a Realtime race. Direct legacy inserts into `tasks` remain supported.

## Task lifecycle

`staged -> pending -> claimed -> running -> completed|failed|cancelled|timed_out`

- `staged`: uploaded/prepared, **not** claimable. Reconciliation, Realtime claim kicks, and `claim_bridge_task` ignore it.
- `pending`: authorized to execute; workers may claim.
- Release: `select * from public.release_staged_bridge_task('<task-uuid>')` (rejects non-staged rows).
- Submit staged: add `p_initial_status := 'staged'` to `submit_bridge_task_v2` (default remains `pending`).

## Legacy

```json
{"p_task_id":"<uuid>","p_prompt":"Report system health.","p_requested_config":null,"p_metadata":{},"p_target":null}
```

No target row means v0.1 behavior: a clean bridge session and the existing requested-config fallback rules.

## New session with an exact config

```json
{
  "p_task_id":"<uuid>",
  "p_prompt":"Run the repository tests and summarize failures.",
  "p_requested_config":"cursor:acp:cursor:auto",
  "p_metadata":{},
  "p_target":{"instance_key":"openclaw:<host>","agent_id":"cursor","session_policy":"new","busy_policy":"queue"}
}
```

## Continue an exact session

```json
{
  "p_task_id":"<uuid>",
  "p_prompt":"Continue the previous analysis.",
  "p_requested_config":"main:native:openai:gpt-5-6-sol:low",
  "p_metadata":{},
  "p_target":{"instance_key":"openclaw:<host>","agent_id":"main","session_policy":"continue","session_key":"agent:main:<key>","session_id":"<durable-session-id>","busy_policy":"reject"}
}
```

The bridge resolves both identifiers from the public metadata-only `runtime.agent.session.listSessionEntries` surface, requires them to name the same current session, verifies persisted activity state, and fails closed on missing/stale/mismatched identity.

## Fork an exact session

```json
{
  "p_task_id":"<uuid>",
  "p_prompt":"Explore an alternative without changing the original thread.",
  "p_requested_config":null,
  "p_metadata":{},
  "p_target":{"instance_key":"openclaw:<host>","agent_id":"main","session_policy":"fork","session_key":"agent:main:<key>","session_id":"<durable-session-id>","busy_policy":"queue"}
}
```

On OpenClaw 2026.7.1-2, `sessions.create` and the atomic transcript-fork implementation are trusted Gateway operations rather than external-plugin APIs. The bridge therefore rejects this target with `session_fork_unsupported`; it does not fake a fork, patch core, or copy private transcripts.

## Project/workspace (managed worktrees unsupported)

Choose keys and paths from `v_execution_targets`:

```json
{
  "instance_key":"openclaw:<host>",
  "agent_id":"main",
  "session_policy":"new",
  "project_key":"<project-key>",
  "project_path":"F:\\RGAT-development",
  "workspace_key":"<workspace-key>",
  "workspace_path":"F:\\RGAT-development",
  "busy_policy":"queue"
}
```

Configured project/workspace keys and paths are cross-checked against `runtime.agent.resolveAgentWorkspaceDir` and the resolved agent config. This build does not expose managed-worktree inventory to external plugins, so `worktree_key`/`worktree_path` fail with `worktree_inventory_unsupported`. It exposes node inventory but no public embedded-agent node-placement argument, so `node_key`/`node_id` fail with `node_target_unsupported`.

`queue` retains the exact busy session and lets OpenClaw serialize it. `reject` fails before execution. There is no preemption or unrelated-run cancellation.

Checkout exclusivity: any active OpenClaw session whose spawned cwd/workspace (or, when absent, the configured agent workspace) resolves to the same normalized checkout path occupies that path. `session_policy=new` and legacy targets cannot bypass this with a fresh session id. Distinct managed worktrees are not exposed on this OpenClaw build; until they are, only a different checkout path counts as a separate resource. `busy_policy=queue` waits for the checkout to become free before `runEmbeddedAgent`; `reject` fails with `workspace_busy`. Continue-session busy checks still exclude the continued session itself so existing same-session queue/reject semantics remain intact.

`task_relations` supports `depends_on`, `parent`, `followup`, and `sibling` as queryable metadata; it does not auto-schedule dependencies. `v_task_relation_cycles` detects multi-hop cycles.
