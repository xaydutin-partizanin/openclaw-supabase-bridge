# Task and session targeting

Use `submit_bridge_task_v2` for targeted work. It inserts the `tasks` and optional `task_targets` rows atomically, avoiding a Realtime race. Direct legacy inserts into `tasks` remain supported.

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

The bridge resolves both identifiers, requires them to name the same current session, verifies current activity through `sessions.list`, and fails closed on missing/stale/mismatched identity.

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

Fork uses public `sessions.create` with the exact parent key and `fork: true`. Source and resulting session IDs are recorded in `runs` and later mirrored in `session_relations`.

## Project/workspace/worktree

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
  "worktree_key":"<worktree-key>",
  "worktree_path":"F:\\RGAT-development\\.openclaw-worktrees\\<id>",
  "busy_policy":"queue"
}
```

Keys and paths are cross-checked against `agents.list` and `worktrees.list`. This build exposes node inventory but no public embedded-agent node-placement argument, so `node_key`/`node_id` currently fail with `node_target_unsupported` rather than pretending placement worked.

`queue` retains the exact busy session and lets OpenClaw serialize it. `reject` fails before execution. There is no preemption or unrelated-run cancellation.

`task_relations` supports `depends_on`, `parent`, `followup`, and `sibling` as queryable metadata; it does not auto-schedule dependencies. `v_task_relation_cycles` detects multi-hop cycles.
