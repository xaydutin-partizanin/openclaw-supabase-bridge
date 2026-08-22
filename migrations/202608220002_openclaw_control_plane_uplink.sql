-- OpenClaw Supabase Bridge v0.2.0
-- Additive control-plane/read-model and exact task-targeting migration.
-- Migration 202608220001 is already deployed and is intentionally not rewritten.

begin;

alter table public.runs
  add column if not exists requested_instance_key text,
  add column if not exists actual_instance_key text,
  add column if not exists requested_agent_id text,
  add column if not exists actual_agent_id text,
  add column if not exists session_policy text,
  add column if not exists source_session_key text,
  add column if not exists source_session_id text,
  add column if not exists actual_session_key text,
  add column if not exists actual_session_id text,
  add column if not exists project_key text,
  add column if not exists project_path text,
  add column if not exists workspace_key text,
  add column if not exists workspace_path text,
  add column if not exists worktree_key text,
  add column if not exists worktree_path text,
  add column if not exists busy_policy text,
  add column if not exists target_failure_code text,
  add column if not exists target_failure_detail text;

create table if not exists public.task_targets (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  instance_key text,
  agent_id text,
  session_policy text not null default 'new' check (session_policy in ('new', 'continue', 'fork')),
  session_key text,
  session_id text,
  project_key text,
  project_path text,
  workspace_key text,
  workspace_path text,
  worktree_key text,
  worktree_path text,
  node_key text,
  node_id text,
  busy_policy text not null default 'queue' check (busy_policy in ('queue', 'reject')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (session_policy = 'new' or session_key is not null or session_id is not null)
);

create table if not exists public.task_relations (
  relation_key text primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  related_task_id uuid not null references public.tasks(id) on delete cascade,
  relation_type text not null check (relation_type in ('depends_on', 'parent', 'followup', 'sibling')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (task_id <> related_task_id),
  unique(task_id, related_task_id, relation_type)
);

drop trigger if exists task_targets_set_updated_at on public.task_targets;
create trigger task_targets_set_updated_at before update on public.task_targets
for each row execute function public.bridge_set_updated_at();

-- Identity, bridge health, and collector state.
create table if not exists public.openclaw_instances (
  instance_key text primary key,
  display_name text,
  hostname text,
  platform text,
  release text,
  arch text,
  openclaw_version text,
  node_version text,
  gateway_port integer,
  gateway_pid integer,
  status text not null default 'unknown',
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.bridge_workers (
  worker_key text primary key,
  instance_key text not null,
  worker_id text not null,
  boot_id text not null,
  plugin_version text,
  status text not null,
  heartbeat_at timestamptz not null,
  supabase_state text,
  realtime_state text,
  agent_event_subscription_state text,
  reconnect_count integer not null default 0,
  buffered_event_count integer not null default 0,
  active_controller_count integer not null default 0,
  last_claim_at timestamptz,
  last_report_at timestamptz,
  last_event_flush_at timestamptz,
  last_telemetry_sync_at timestamptz,
  last_error text,
  started_at timestamptz,
  stopped_at timestamptz,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  unique(instance_key, worker_id)
);

create table if not exists public.telemetry_collectors (
  collector_key text primary key,
  instance_key text not null,
  worker_id text not null,
  boot_id text not null,
  collector_id text not null,
  domain text not null,
  status text not null,
  event_driven boolean not null default false,
  current_interval_ms bigint,
  consecutive_failures integer not null default 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_run_at timestamptz,
  last_error text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  unique(instance_key, worker_id, collector_id)
);

create table if not exists public.telemetry_sync_runs (
  sync_run_key text primary key,
  instance_key text not null,
  worker_id text not null,
  boot_id text not null,
  collector_id text not null,
  domain text not null,
  status text not null,
  authority text,
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms bigint,
  error text,
  ingested_at timestamptz not null default now()
);

-- Gateway and configuration state.
create table if not exists public.gateway_status (
  instance_key text primary key,
  healthy boolean not null,
  reachable boolean not null,
  event_loop_degraded boolean not null default false,
  config_reload_status text,
  loaded_plugin_count integer,
  plugin_error_count integer,
  heartbeat_seconds integer,
  uptime_ms bigint,
  last_error text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.gateway_metric_samples (
  sample_key text primary key,
  instance_key text not null,
  sampled_at timestamptz not null,
  event_loop_delay_p99_ms double precision,
  event_loop_delay_max_ms double precision,
  event_loop_utilization double precision,
  cpu_core_ratio double precision,
  memory_free_bytes bigint,
  disk_available_bytes bigint,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.gateway_config_state (
  instance_key text primary key,
  config_fingerprint text not null,
  safe_shape jsonb not null default '{}'::jsonb,
  secret_values_excluded boolean not null default true,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

-- Agents, providers, models, auth and usage.
create table if not exists public.openclaw_agents (
  agent_key text primary key,
  instance_key text not null,
  agent_id text not null,
  name text,
  is_default boolean not null default false,
  available boolean not null default false,
  workspace_path text,
  workspace_git boolean,
  runtime_id text,
  runtime_source text,
  primary_model_ref text,
  thinking_default text,
  capabilities jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, agent_id)
);

create table if not exists public.agent_bindings (
  binding_key text primary key,
  instance_key text not null,
  agent_key text not null,
  binding_type text not null,
  target_key text,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.models (
  model_key text primary key,
  instance_key text not null,
  provider_key text not null,
  model_id text not null,
  display_name text,
  available boolean not null default false,
  context_tokens bigint,
  input_modalities jsonb not null default '[]'::jsonb,
  capabilities jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, provider_key, model_id)
);

create table if not exists public.model_auth_status (
  auth_key text primary key,
  instance_key text not null,
  provider_key text not null,
  status text not null,
  profile_count integer,
  expires_at timestamptz,
  secret_material_excluded boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, provider_key)
);

create table if not exists public.model_run_usage (
  usage_key text primary key,
  instance_key text not null,
  run_id text not null,
  session_key text,
  session_id text,
  agent_id text,
  provider_key text not null,
  model text,
  harness_id text,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  total_tokens bigint,
  cost_amount numeric,
  cost_currency text,
  cost_derived boolean not null default false,
  authority text not null,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.acp_backends (
  backend_key text primary key,
  instance_key text not null,
  backend_id text not null,
  agent_id text,
  harness_agent text,
  mode text,
  cwd text,
  available boolean not null default false,
  health_status text,
  quota_supported boolean not null default false,
  quota_limitation text,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.agent_harnesses (
  harness_key text primary key,
  instance_key text not null,
  agent_id text not null,
  harness_id text not null,
  source text,
  available boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

-- Sessions and OpenClaw task registries. No transcript/prompt/reply bodies.
create table if not exists public.openclaw_sessions (
  session_key text primary key,
  instance_key text not null,
  session_id text not null,
  agent_key text,
  agent_id text,
  kind text,
  label text,
  display_name text,
  status text,
  has_active_run boolean not null default false,
  archived boolean not null default false,
  pinned boolean not null default false,
  unread boolean not null default false,
  parent_session_key text,
  runtime_id text,
  model_provider text,
  model text,
  total_tokens bigint,
  total_tokens_fresh boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  updated_at_source timestamptz,
  workspace_path text,
  cwd text,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, session_id)
);

create table if not exists public.session_active_runs (
  active_run_key text primary key,
  instance_key text not null,
  session_key text not null,
  session_id text,
  run_id text,
  status text not null,
  started_at timestamptz,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, session_key)
);

create table if not exists public.session_relations (
  relation_key text primary key,
  instance_key text not null,
  parent_session_key text not null,
  child_session_key text not null,
  relation_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.openclaw_tasks (
  task_key text primary key,
  instance_key text not null,
  openclaw_task_id text not null,
  runtime text,
  source_id text,
  session_key text,
  child_session_key text,
  flow_id text,
  parent_task_id text,
  agent_id text,
  run_id text,
  label text,
  title text,
  status text not null,
  delivery_status text,
  notify_policy text,
  created_at_source timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  last_event_at timestamptz,
  error text,
  progress_summary text,
  terminal_summary text,
  terminal_outcome text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, openclaw_task_id)
);

create table if not exists public.task_flows (
  flow_key text primary key,
  instance_key text not null,
  flow_id text not null,
  owner_key text,
  session_key text,
  status text not null,
  notify_policy text,
  goal text,
  current_step text,
  created_at_source timestamptz,
  updated_at_source timestamptz,
  ended_at timestamptz,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, flow_id)
);

create table if not exists public.task_flow_members (
  member_key text primary key,
  instance_key text not null,
  flow_id text not null,
  openclaw_task_id text not null,
  parent_task_id text,
  status text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

-- Cron, channels, plugins and capability inventory.
create table if not exists public.cron_jobs (
  cron_key text primary key,
  instance_key text not null,
  cron_id text not null,
  agent_id text,
  name text,
  description text,
  enabled boolean not null default true,
  schedule_kind text,
  schedule_expression text,
  timezone text,
  session_target text,
  wake_mode text,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  last_error text,
  payload_body_excluded boolean not null default true,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, cron_id)
);

create table if not exists public.cron_runs (
  cron_run_key text primary key,
  instance_key text not null,
  cron_id text not null,
  run_id text,
  session_key text,
  status text not null,
  started_at timestamptz,
  duration_ms bigint,
  error text,
  summary text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.channel_accounts (
  account_key text primary key,
  instance_key text not null,
  channel_id text not null,
  account_id text not null,
  enabled boolean not null default false,
  configured boolean not null default false,
  running boolean not null default false,
  connected boolean not null default false,
  restart_pending boolean not null default false,
  reconnect_attempts integer not null default 0,
  last_connected_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_error text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, channel_id, account_id)
);

create table if not exists public.openclaw_plugins (
  plugin_key text primary key,
  instance_key text not null,
  plugin_id text not null,
  name text,
  version text,
  status text,
  enabled boolean not null default false,
  origin text,
  capability_kinds jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, plugin_id)
);

create table if not exists public.plugin_hooks (
  hook_key text primary key,
  instance_key text not null,
  plugin_id text not null,
  hook_name text not null,
  registered boolean not null default false,
  observation_only boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.tools (
  tool_key text primary key,
  instance_key text not null,
  tool_name text not null,
  plugin_id text,
  display_name text,
  description text,
  risk text,
  available boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.agent_tools (
  agent_tool_key text primary key,
  instance_key text not null,
  agent_id text not null,
  tool_key text not null,
  enabled boolean not null default true,
  authority text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.skills (
  skill_key text primary key,
  instance_key text not null,
  skill_name text not null,
  source text,
  bundled boolean not null default false,
  eligible boolean not null default false,
  disabled boolean not null default false,
  user_invocable boolean not null default false,
  command_visible boolean not null default false,
  file_path text,
  requirements jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.agent_skills (
  agent_skill_key text primary key,
  instance_key text not null,
  agent_id text not null,
  skill_key text not null,
  eligible boolean not null default false,
  enabled boolean not null default false,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.mcp_servers (
  server_key text primary key,
  instance_key text not null,
  server_name text not null,
  owner text,
  enabled boolean not null default false,
  transport text,
  command_and_env_excluded boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

-- Policy, approvals, security, memory and file metadata.
create table if not exists public.execution_policies (
  policy_key text primary key,
  instance_key text not null,
  scope_type text not null,
  scope_key text not null,
  sandbox_mode text,
  exec_host text,
  exec_security text,
  exec_ask text,
  default_workspace_path text,
  policy_metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.approvals (
  approval_key text primary key,
  instance_key text not null,
  approval_id text not null,
  kind text,
  status text not null,
  title text,
  agent_id text,
  session_key text,
  run_id text,
  requested_at timestamptz,
  resolved_at timestamptz,
  command_body_excluded boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.security_findings (
  finding_key text primary key,
  instance_key text not null,
  finding_id text,
  code text not null,
  severity text,
  status text,
  title text,
  source text,
  sensitive_detail_excluded boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.memory_status (
  memory_key text primary key,
  instance_key text not null,
  agent_id text not null,
  provider text,
  embedding_ready boolean not null default false,
  embedding_checked boolean not null default false,
  status text,
  dreaming_enabled boolean not null default false,
  short_term_count bigint,
  signal_count bigint,
  memory_contents_excluded boolean not null default true,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.policy_documents (
  document_key text primary key,
  instance_key text not null,
  agent_id text,
  document_name text not null,
  path text,
  exists boolean not null default false,
  size_bytes bigint,
  modified_at timestamptz,
  contents_excluded boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

-- Projects, workspaces, worktrees, nodes, devices, and browser metadata.
create table if not exists public.projects (
  project_key text primary key,
  instance_key text not null,
  name text,
  root_path text not null,
  source text,
  available boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.workspaces (
  workspace_key text primary key,
  instance_key text not null,
  project_key text,
  agent_id text,
  path text not null,
  kind text,
  available boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.worktrees (
  worktree_key text primary key,
  instance_key text not null,
  worktree_id text not null,
  project_key text,
  owner_kind text,
  owner_id text,
  path text not null,
  branch text,
  available boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, worktree_id)
);

create table if not exists public.nodes (
  node_key text primary key,
  instance_key text not null,
  node_id text not null,
  display_name text,
  connected boolean not null default false,
  capabilities jsonb not null default '[]'::jsonb,
  commands jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, node_id)
);

create table if not exists public.devices (
  device_key text primary key,
  instance_key text not null,
  device_id text not null,
  display_name text,
  platform text,
  paired boolean not null default false,
  connected boolean not null default false,
  scopes jsonb not null default '[]'::jsonb,
  token_material_excluded boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text,
  unique(instance_key, device_id)
);

create table if not exists public.browser_profiles (
  profile_key text primary key,
  instance_key text not null,
  profile_id text not null,
  display_name text,
  status text,
  available boolean not null default false,
  content_excluded boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'unsupported',
  boot_id text
);

-- Bounded operational events, rollups, and generic unsupported/escape-hatch state.
create table if not exists public.operational_events (
  event_key text primary key,
  instance_key text not null,
  boot_id text,
  source text not null,
  domain text not null,
  severity text not null,
  event_type text not null,
  event_ts timestamptz not null,
  agent_id text,
  session_key text,
  session_id text,
  run_id text,
  bridge_task_id uuid references public.tasks(id) on delete set null,
  summary text,
  data jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now()
);

create table if not exists public.error_rollups (
  rollup_key text primary key,
  instance_key text not null,
  domain text not null,
  error_code text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  occurrence_count bigint not null default 0,
  last_error_at timestamptz,
  sample_summary text,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create table if not exists public.state_documents (
  document_key text primary key,
  instance_key text not null,
  domain text not null,
  authority text not null,
  supported boolean not null default false,
  document jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_changed_at timestamptz not null default now(),
  stale_after timestamptz not null,
  freshness text not null default 'fresh',
  boot_id text
);

create or replace function public.record_bridge_error_rollup(
  p_rollup_key text,
  p_instance_key text,
  p_domain text,
  p_error_code text,
  p_observed_at timestamptz,
  p_sample_summary text,
  p_boot_id text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.error_rollups(
    rollup_key, instance_key, domain, error_code, window_start, window_end,
    occurrence_count, last_error_at, sample_summary,
    source_observed_at, ingested_at, last_success_at, last_changed_at, stale_after, freshness, boot_id
  ) values (
    p_rollup_key, p_instance_key, p_domain, p_error_code, date_trunc('hour', p_observed_at), p_observed_at,
    1, p_observed_at, left(p_sample_summary, 2000),
    p_observed_at, now(), now(), now(), p_observed_at + interval '24 hours', 'fresh', p_boot_id
  )
  on conflict (rollup_key) do update set
    window_end = greatest(public.error_rollups.window_end, excluded.window_end),
    occurrence_count = public.error_rollups.occurrence_count + 1,
    last_error_at = greatest(public.error_rollups.last_error_at, excluded.last_error_at),
    sample_summary = excluded.sample_summary,
    source_observed_at = excluded.source_observed_at,
    ingested_at = now(),
    last_success_at = now(),
    last_changed_at = now(),
    stale_after = excluded.stale_after,
    freshness = 'fresh',
    boot_id = excluded.boot_id;
$$;

-- Preserve atomic task claiming while recording requested and actual execution placement.
create or replace function public.start_bridge_run_v2(
  p_run_id uuid,
  p_task_id uuid,
  p_worker_id text,
  p_requested_config text,
  p_used_config text,
  p_fallback_used boolean,
  p_fallback_reason text,
  p_config_id uuid,
  p_provider_id uuid,
  p_provider_key text,
  p_runtime text,
  p_agent text,
  p_model text,
  p_effort text,
  p_parent_session_key text,
  p_parent_session_id text,
  p_requested_instance_key text,
  p_actual_instance_key text,
  p_requested_agent_id text,
  p_actual_agent_id text,
  p_session_policy text,
  p_source_session_key text,
  p_source_session_id text,
  p_actual_session_key text,
  p_actual_session_id text,
  p_project_key text,
  p_project_path text,
  p_workspace_key text,
  p_workspace_path text,
  p_worktree_key text,
  p_worktree_path text,
  p_busy_policy text,
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
begin
  update public.tasks
  set status = 'running', updated_at = now()
  where id = p_task_id
    and status = 'claimed'
    and claimed_by = p_worker_id
    and lease_expires_at > now()
  returning * into v_task;

  if not found then
    return;
  end if;

  insert into public.runs(
    id, task_id, status, requested_config, used_config, fallback_used, fallback_reason,
    config_id, provider_id, provider_key, runtime, agent, model, effort,
    parent_session_key, parent_session_id,
    requested_instance_key, actual_instance_key, requested_agent_id, actual_agent_id,
    session_policy, source_session_key, source_session_id, actual_session_key, actual_session_id,
    project_key, project_path, workspace_key, workspace_path, worktree_key, worktree_path,
    busy_policy, metadata, started_at
  ) values (
    p_run_id, p_task_id, 'running', p_requested_config, p_used_config, p_fallback_used, p_fallback_reason,
    p_config_id, p_provider_id, p_provider_key, p_runtime, p_agent, p_model, p_effort,
    p_parent_session_key, p_parent_session_id,
    p_requested_instance_key, p_actual_instance_key, p_requested_agent_id, p_actual_agent_id,
    p_session_policy, p_source_session_key, p_source_session_id, p_actual_session_key, p_actual_session_id,
    p_project_key, p_project_path, p_workspace_key, p_workspace_path, p_worktree_key, p_worktree_path,
    p_busy_policy, coalesce(p_metadata, '{}'::jsonb), now()
  );
  return query select * from public.runs where id = p_run_id;
end;
$$;

create or replace function public.bridge_effective_freshness(p_stale_after timestamptz, p_freshness text)
returns text
language sql
stable
as $$
  select case
    when p_freshness in ('error', 'unsupported') then p_freshness
    when p_stale_after is null or p_stale_after <= now() then 'stale'
    else 'fresh'
  end
$$;

-- Atomic submission avoids a Realtime race between the task row and its optional exact target.
create or replace function public.submit_bridge_task_v2(
  p_task_id uuid,
  p_prompt text,
  p_requested_config text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_target jsonb default null
)
returns setof public.tasks
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tasks(id, prompt, requested_config, status, metadata)
  values (p_task_id, p_prompt, p_requested_config, 'pending', coalesce(p_metadata, '{}'::jsonb));

  if p_target is not null then
    insert into public.task_targets(
      task_id, instance_key, agent_id, session_policy, session_key, session_id,
      project_key, project_path, workspace_key, workspace_path, worktree_key, worktree_path,
      node_key, node_id, busy_policy, metadata
    ) values (
      p_task_id,
      nullif(p_target->>'instance_key', ''),
      nullif(p_target->>'agent_id', ''),
      coalesce(nullif(p_target->>'session_policy', ''), 'new'),
      nullif(p_target->>'session_key', ''),
      nullif(p_target->>'session_id', ''),
      nullif(p_target->>'project_key', ''),
      nullif(p_target->>'project_path', ''),
      nullif(p_target->>'workspace_key', ''),
      nullif(p_target->>'workspace_path', ''),
      nullif(p_target->>'worktree_key', ''),
      nullif(p_target->>'worktree_path', ''),
      nullif(p_target->>'node_key', ''),
      nullif(p_target->>'node_id', ''),
      coalesce(nullif(p_target->>'busy_policy', ''), 'queue'),
      coalesce(p_target->'metadata', '{}'::jsonb)
    );
  end if;

  return query select * from public.tasks where id = p_task_id;
end;
$$;

-- Chatter-oriented read models. Every health view computes staleness at query time.
create or replace view public.v_system_overview with (security_invoker = true) as
select
  i.instance_key,
  i.display_name,
  i.openclaw_version,
  g.healthy as gateway_healthy,
  public.bridge_effective_freshness(g.stale_after, g.freshness) as gateway_freshness,
  bw.worker_id,
  bw.status as bridge_status,
  bw.heartbeat_at,
  public.bridge_effective_freshness(bw.stale_after, bw.freshness) as bridge_freshness,
  bw.realtime_state,
  (select count(*) from public.openclaw_agents a where a.instance_key = i.instance_key and a.available) as available_agents,
  (select count(*) from public.openclaw_sessions s where s.instance_key = i.instance_key and s.has_active_run and public.bridge_effective_freshness(s.stale_after, s.freshness) = 'fresh') as active_sessions,
  (select count(*) from public.openclaw_tasks t where t.instance_key = i.instance_key and t.status in ('queued','running') and public.bridge_effective_freshness(t.stale_after, t.freshness) = 'fresh') as active_openclaw_tasks,
  (select count(*) from public.channel_accounts c where c.instance_key = i.instance_key and (not c.connected or c.stale_after <= now())) as degraded_channels,
  (select count(*) from public.telemetry_collectors c where c.instance_key = i.instance_key and (c.status = 'backoff' or c.stale_after <= now())) as failing_collectors,
  (select count(*) from public.tasks t where t.status in ('failed','timed_out','lost')) as failed_bridge_tasks,
  (select count(*) from public.quota_status q where q.status in ('error','unknown') or (q.remaining is not null and q.remaining <= 10)) as quota_attention_count,
  (select max(s.finished_at) from public.telemetry_sync_runs s where s.instance_key = i.instance_key and s.status = 'success') as last_sync_at,
  i.source_observed_at
from public.openclaw_instances i
left join public.gateway_status g using (instance_key)
left join lateral (
  select b.* from public.bridge_workers b
  where b.instance_key = i.instance_key
  order by b.heartbeat_at desc limit 1
) bw on true;

create or replace view public.v_execution_targets with (security_invoker = true) as
select
  a.instance_key,
  a.agent_id,
  a.name as agent_name,
  a.runtime_id,
  a.primary_model_ref,
  a.workspace_path,
  w.workspace_key,
  p.project_key,
  p.name as project_name,
  wt.worktree_key,
  wt.worktree_id,
  wt.path as worktree_path,
  coalesce(wt.path, w.path, a.workspace_path) as executable_cwd,
  a.available,
  case when exists (
    select 1 from public.openclaw_sessions s
    where s.instance_key = a.instance_key and s.agent_id = a.agent_id and s.has_active_run and public.bridge_effective_freshness(s.stale_after, s.freshness) = 'fresh'
  ) then 'busy' else 'idle' end as activity,
  (select count(*) from public.openclaw_sessions s where s.instance_key = a.instance_key and s.agent_id = a.agent_id and s.has_active_run and public.bridge_effective_freshness(s.stale_after, s.freshness) = 'fresh') as active_session_count,
  configs.available_configs,
  configs.default_config,
  capabilities.tools,
  capabilities.skills,
  policy.sandbox_mode,
  policy.exec_host,
  policy.exec_security,
  policy.exec_ask,
  acp.backend_id as acp_backend,
  acp.health_status as acp_health,
  public.bridge_effective_freshness(a.stale_after, a.freshness) as freshness
from public.openclaw_agents a
left join public.workspaces w on w.instance_key = a.instance_key and w.agent_id = a.agent_id and w.available
left join public.projects p on p.project_key = w.project_key
left join public.worktrees wt on wt.instance_key = a.instance_key and wt.project_key = p.project_key and wt.available
left join lateral (
  select
    coalesce(jsonb_agg(jsonb_build_object('config_key', c.config_key, 'runtime', c.runtime, 'provider', cp.provider_key, 'model', c.model, 'effort', c.effort) order by c.is_default desc, c.config_key) filter (where c.available), '[]'::jsonb) as available_configs,
    max(c.config_key) filter (where c.is_default and c.available) as default_config
  from public.agent_configs c
  join public.providers cp on cp.id = c.provider_id
  where c.agent = a.agent_id
) configs on true
left join lateral (
  select
    coalesce(jsonb_agg(distinct t.tool_name) filter (where at.enabled), '[]'::jsonb) as tools,
    coalesce(jsonb_agg(distinct s.skill_name) filter (where aks.enabled and aks.eligible), '[]'::jsonb) as skills
  from public.agent_tools at
  full join public.agent_skills aks on aks.instance_key = at.instance_key and aks.agent_id = at.agent_id
  left join public.tools t on t.tool_key = at.tool_key
  left join public.skills s on s.skill_key = aks.skill_key
  where coalesce(at.instance_key, aks.instance_key) = a.instance_key and coalesce(at.agent_id, aks.agent_id) = a.agent_id
) capabilities on true
left join public.execution_policies policy on policy.instance_key = a.instance_key and policy.scope_type = 'global'
left join public.acp_backends acp on acp.instance_key = a.instance_key and acp.agent_id = a.agent_id;

create or replace view public.v_session_picker with (security_invoker = true) as
select
  s.instance_key,
  s.session_key,
  s.session_id,
  s.agent_id,
  s.label,
  s.display_name,
  s.status,
  s.has_active_run,
  ar.run_id as active_run_id,
  ar.started_at as active_run_started_at,
  s.parent_session_key,
  s.workspace_path,
  s.cwd,
  s.model_provider,
  s.model,
  s.updated_at_source,
  public.bridge_effective_freshness(s.stale_after, s.freshness) as freshness,
  case when s.has_active_run then array['queue','reject']::text[] else array['queue']::text[] end as busy_policy_options,
  array['continue','fork']::text[] as session_policy_options
from public.openclaw_sessions s
left join public.session_active_runs ar on ar.instance_key = s.instance_key and ar.session_key = s.session_key and ar.status = 'running' and public.bridge_effective_freshness(ar.stale_after, ar.freshness) = 'fresh'
where not s.archived;

create or replace view public.v_active_work with (security_invoker = true) as
select
  'bridge'::text as work_layer,
  r.id::text as work_id,
  r.task_id::text as bridge_task_id,
  r.actual_agent_id as agent_id,
  r.actual_session_key as session_key,
  r.status,
  r.started_at,
  r.openclaw_task_id,
  r.openclaw_run_id,
  r.workspace_path,
  r.worktree_path,
  r.error
from public.runs r
where r.status in ('created','claimed','running')
union all
select
  'openclaw'::text,
  t.openclaw_task_id,
  null::text,
  t.agent_id,
  t.session_key,
  t.status,
  t.started_at,
  t.openclaw_task_id,
  t.run_id,
  null::text,
  null::text,
  t.error
from public.openclaw_tasks t
where t.status in ('queued','running') and public.bridge_effective_freshness(t.stale_after, t.freshness) = 'fresh'
union all
select
  'session'::text,
  s.session_key,
  null::text,
  s.agent_id,
  s.session_key,
  s.status,
  ar.started_at,
  null::text,
  ar.run_id,
  s.workspace_path,
  null::text,
  null::text
from public.openclaw_sessions s
left join public.session_active_runs ar on ar.instance_key = s.instance_key and ar.session_key = s.session_key and ar.status = 'running' and public.bridge_effective_freshness(ar.stale_after, ar.freshness) = 'fresh'
where s.has_active_run and public.bridge_effective_freshness(s.stale_after, s.freshness) = 'fresh'
union all
select
  'flow'::text,
  f.flow_id,
  null::text,
  null::text,
  f.session_key,
  f.status,
  f.created_at_source,
  null::text,
  null::text,
  null::text,
  null::text,
  null::text
from public.task_flows f
where f.status in ('queued','running','waiting') and public.bridge_effective_freshness(f.stale_after, f.freshness) = 'fresh';

create or replace view public.v_provider_status with (security_invoker = true) as
select
  p.provider_key,
  p.name,
  p.available,
  a.instance_key,
  a.status as auth_status,
  public.bridge_effective_freshness(a.stale_after, a.freshness) as auth_freshness,
  configs.available_configs,
  configs.default_config,
  usage.last_usage_at,
  usage.last_usage_tokens,
  usage.usage_authority,
  q.account_key,
  q.quota_key,
  q.remaining,
  q.limit_value,
  q.unit,
  q.reset_at,
  q.checked_at,
  q.status as quota_status,
  q.source as quota_source,
  case when q.checked_at is null or q.checked_at < now() - interval '45 minutes' then 'stale' else q.status end as freshness
from public.providers p
left join public.model_auth_status a on a.provider_key = p.provider_key
left join public.quota_status q on q.provider_id = p.id
left join lateral (
  select
    coalesce(jsonb_agg(jsonb_build_object('config_key', c.config_key, 'agent', c.agent, 'runtime', c.runtime, 'model', c.model) order by c.is_default desc, c.config_key) filter (where c.available), '[]'::jsonb) as available_configs,
    max(c.config_key) filter (where c.is_default and c.available) as default_config
  from public.agent_configs c where c.provider_id = p.id
) configs on true
left join lateral (
  select max(u.source_observed_at) as last_usage_at,
    (array_agg(u.total_tokens order by u.source_observed_at desc))[1] as last_usage_tokens,
    (array_agg(u.authority order by u.source_observed_at desc))[1] as usage_authority
  from public.model_run_usage u where u.provider_key = p.provider_key
) usage on true;

create or replace view public.v_attention_needed with (security_invoker = true) as
select 'bridge'::text as domain, worker_key as item_key, 'stale_heartbeat'::text as reason, heartbeat_at as observed_at, last_error as detail
from public.bridge_workers
where stale_after <= now() or realtime_state in ('disconnected','error') or status <> 'running'
union all
select 'collector', collector_key, case when freshness = 'error' then 'collector_error' else 'collector_stale' end, coalesce(last_attempt_at, source_observed_at), last_error
from public.telemetry_collectors
where freshness = 'error' or stale_after <= now()
union all
select 'task', task_key, 'task_terminal_problem', coalesce(last_event_at, source_observed_at), coalesce(error, terminal_summary)
from public.openclaw_tasks
where status in ('failed','timed_out','lost')
union all
select 'approval', approval_key, 'approval_pending', coalesce(requested_at, source_observed_at), title
from public.approvals where status = 'pending'
union all
select 'quota', quota_identity, 'provider_capacity', checked_at, coalesce(other->>'error', status)
from public.quota_status where status in ('error','unknown') or (remaining is not null and remaining <= 10)
union all
select 'security', finding_key, 'security_finding', source_observed_at, title
from public.security_findings where severity in ('warning','high','critical','error') and status not in ('resolved','ignored')
union all
select 'channel', account_key, 'channel_disconnected', source_observed_at, last_error
from public.channel_accounts where not connected or stale_after <= now()
union all
select 'acp', backend_key, 'acp_unhealthy', source_observed_at, quota_limitation
from public.acp_backends where not available or health_status not in ('configured','healthy','connected')
union all
select 'bridge-task', t.id::text, 'bridge_task_problem', t.updated_at,
  (select r.error from public.runs r where r.task_id = t.id order by r.created_at desc limit 1)
from public.tasks t where t.status in ('failed','timed_out','lost')
union all
select 'errors', rollup_key, 'repeated_error', last_error_at, sample_summary
from public.error_rollups where occurrence_count >= 3 and last_error_at >= now() - interval '24 hours';

create or replace view public.v_bridge_health with (security_invoker = true) as
select
  b.instance_key,
  b.worker_id,
  b.boot_id,
  b.plugin_version,
  b.status,
  b.heartbeat_at,
  b.supabase_state,
  b.realtime_state,
  b.agent_event_subscription_state,
  b.reconnect_count,
  b.buffered_event_count,
  b.active_controller_count,
  b.last_claim_at,
  b.last_report_at,
  b.last_event_flush_at,
  b.last_telemetry_sync_at,
  b.last_error,
  public.bridge_effective_freshness(b.stale_after, b.freshness) as freshness,
  count(c.collector_key) as collector_count,
  count(c.collector_key) filter (where c.status = 'unsupported') as unsupported_collectors,
  count(c.collector_key) filter (where c.status = 'backoff' or c.freshness = 'error') as failing_collectors,
  max(c.last_success_at) as latest_collector_success,
  coalesce(jsonb_agg(jsonb_build_object(
    'collector_id', c.collector_id,
    'domain', c.domain,
    'status', c.status,
    'interval_ms', c.current_interval_ms,
    'failures', c.consecutive_failures,
    'last_success_at', c.last_success_at,
    'next_run_at', c.next_run_at,
    'last_error', c.last_error
  ) order by c.collector_id) filter (where c.collector_key is not null), '[]'::jsonb) as collectors
from public.bridge_workers b
left join public.telemetry_collectors c
  on c.instance_key = b.instance_key and c.worker_id = b.worker_id and c.boot_id = b.boot_id
group by b.worker_key;

create or replace view public.v_task_relation_cycles with (security_invoker = true) as
with recursive walk(origin_task_id, current_task_id, path, cycle) as (
  select r.task_id, r.related_task_id, array[r.task_id, r.related_task_id], r.related_task_id = r.task_id
  from public.task_relations r
  union all
  select w.origin_task_id, r.related_task_id, w.path || r.related_task_id, r.related_task_id = any(w.path)
  from walk w
  join public.task_relations r on r.task_id = w.current_task_id
  where not w.cycle and cardinality(w.path) < 64
)
select distinct origin_task_id, current_task_id as repeated_task_id, path
from walk
where cycle;

-- Useful indexes for Chatter and reconciliation queries.
create index if not exists task_targets_instance_agent_idx on public.task_targets(instance_key, agent_id);
create index if not exists task_targets_session_idx on public.task_targets(session_key, session_id);
create index if not exists task_targets_placement_idx on public.task_targets(project_key, workspace_key, worktree_key);
create index if not exists task_relations_task_idx on public.task_relations(task_id, relation_type);
create index if not exists runs_actual_session_idx on public.runs(actual_session_key, started_at desc);
create index if not exists bridge_workers_heartbeat_idx on public.bridge_workers(instance_key, heartbeat_at desc);
create index if not exists telemetry_collectors_health_idx on public.telemetry_collectors(instance_key, freshness, stale_after);
create index if not exists telemetry_sync_runs_recent_idx on public.telemetry_sync_runs(instance_key, started_at desc);
create index if not exists gateway_metric_samples_recent_idx on public.gateway_metric_samples(instance_key, sampled_at desc);
create index if not exists openclaw_sessions_agent_recent_idx on public.openclaw_sessions(instance_key, agent_id, updated_at_source desc);
create index if not exists openclaw_sessions_active_idx on public.openclaw_sessions(instance_key, has_active_run) where has_active_run;
create index if not exists openclaw_tasks_status_idx on public.openclaw_tasks(instance_key, status, last_event_at desc);
create index if not exists workspaces_project_agent_idx on public.workspaces(instance_key, project_key, agent_id);
create index if not exists worktrees_project_idx on public.worktrees(instance_key, project_key, available);
create index if not exists channel_accounts_health_idx on public.channel_accounts(instance_key, connected, stale_after);
create index if not exists approvals_pending_idx on public.approvals(instance_key, requested_at) where status = 'pending';
create index if not exists security_findings_attention_idx on public.security_findings(instance_key, severity, status);
create index if not exists error_rollups_recent_idx on public.error_rollups(instance_key, last_error_at desc);
create index if not exists model_run_usage_run_idx on public.model_run_usage(instance_key, run_id);
create index if not exists operational_events_recent_idx on public.operational_events(instance_key, event_ts desc);
create index if not exists operational_events_correlation_idx on public.operational_events(run_id, session_key, event_ts);
create index if not exists quota_status_checked_idx on public.quota_status(checked_at desc);

-- Service-role-only read/write plane. No anon/authenticated policies are introduced.
do $$
declare
  t text;
begin
  foreach t in array array[
    'task_targets','task_relations','openclaw_instances','bridge_workers','telemetry_collectors','telemetry_sync_runs',
    'gateway_status','gateway_metric_samples','gateway_config_state','openclaw_agents','agent_bindings','models',
    'model_auth_status','model_run_usage','acp_backends','agent_harnesses','openclaw_sessions','session_active_runs',
    'session_relations','openclaw_tasks','task_flows','task_flow_members','cron_jobs','cron_runs','channel_accounts',
    'openclaw_plugins','plugin_hooks','tools','agent_tools','skills','agent_skills','mcp_servers','execution_policies',
    'approvals','security_findings','memory_status','policy_documents','projects','workspaces','worktrees','nodes',
    'devices','browser_profiles','operational_events','error_rollups','state_documents'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

revoke all on function public.start_bridge_run_v2(uuid, uuid, text, text, text, boolean, text, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.start_bridge_run_v2(uuid, uuid, text, text, text, boolean, text, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, jsonb) to service_role;
revoke all on function public.bridge_effective_freshness(timestamptz, text) from public, anon, authenticated;
grant execute on function public.bridge_effective_freshness(timestamptz, text) to service_role;
revoke all on function public.record_bridge_error_rollup(text, text, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.record_bridge_error_rollup(text, text, text, text, timestamptz, text, text) to service_role;
revoke all on function public.submit_bridge_task_v2(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.submit_bridge_task_v2(uuid, text, text, jsonb, jsonb) to service_role;

revoke all on public.v_system_overview, public.v_execution_targets, public.v_session_picker,
  public.v_active_work, public.v_provider_status, public.v_attention_needed, public.v_bridge_health,
  public.v_task_relation_cycles
  from anon, authenticated;
grant select on public.v_system_overview, public.v_execution_targets, public.v_session_picker,
  public.v_active_work, public.v_provider_status, public.v_attention_needed, public.v_bridge_health,
  public.v_task_relation_cycles
  to service_role;

comment on table public.task_targets is 'Narrow task submission target plane; exact targets fail closed.';
comment on table public.openclaw_sessions is 'Safe session metadata only. General transcript, prompt, and reply bodies are intentionally excluded.';
comment on table public.operational_events is 'Bounded global operational summaries; not a raw log or transcript warehouse.';
comment on table public.state_documents is 'Escape hatch for unsupported or low-cardinality structured state with explicit authority.';
comment on column public.model_run_usage.cost_derived is 'True only for explicitly derived cost; false never implies an authoritative currency cost exists.';

commit;
