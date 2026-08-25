-- Additive: non-executable staged task status + explicit release to pending.
-- Migration 202608220001 / 202608220002 remain deployed and are intentionally not rewritten.
-- staged is invisible to claim_bridge_task and list_bridge_reconciliation_tasks.

alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks
  add constraint tasks_status_check check (
    status in (
      'staged',
      'pending',
      'claimed',
      'running',
      'completed',
      'failed',
      'cancelled',
      'timed_out'
    )
  );

comment on column public.tasks.status is
  'staged=prepared non-executable; pending=claimable; claimed/running=in flight; terminal=completed|failed|cancelled|timed_out';

-- Optional initial status for atomic submit. Default remains pending for backward compatibility.
drop function if exists public.submit_bridge_task_v2(uuid, text, text, jsonb, jsonb);

create or replace function public.submit_bridge_task_v2(
  p_task_id uuid,
  p_prompt text,
  p_requested_config text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_target jsonb default null,
  p_initial_status text default 'pending'
)
returns setof public.tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := lower(btrim(coalesce(p_initial_status, 'pending')));
begin
  if v_status not in ('pending', 'staged') then
    raise exception 'initial status must be pending or staged, got %', p_initial_status;
  end if;

  insert into public.tasks(id, prompt, requested_config, status, metadata)
  values (p_task_id, p_prompt, p_requested_config, v_status, coalesce(p_metadata, '{}'::jsonb));

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

-- Explicit authorization gate: only staged -> pending. Never rewrites terminal or in-flight work.
create or replace function public.release_staged_bridge_task(p_task_id uuid)
returns setof public.tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'task % not found', p_task_id;
  end if;

  if v_status is distinct from 'staged' then
    raise exception 'task % is %; only staged tasks can be released to pending', p_task_id, v_status;
  end if;

  return query
  update public.tasks
  set status = 'pending',
      claimed_by = null,
      claimed_at = null,
      lease_expires_at = null
  where id = p_task_id
    and status = 'staged'
  returning *;
end;
$$;

-- Reaffirm claim/reconcile ignore staged (already true; kept explicit for reviewers).
create or replace function public.claim_bridge_task(
  p_task_id uuid,
  p_worker_id text,
  p_lease_seconds integer
)
returns setof public.tasks
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(btrim(p_worker_id)) = 0 then
    raise exception 'worker id is required';
  end if;
  if p_lease_seconds < 60 then
    raise exception 'lease must be at least 60 seconds';
  end if;
  return query
  update public.tasks
  set status = 'claimed',
      claimed_by = p_worker_id,
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_task_id
    and (
      status = 'pending'
      or (status = 'claimed' and coalesce(lease_expires_at, '-infinity'::timestamptz) <= now())
    )
  returning *;
end;
$$;

create or replace function public.list_bridge_reconciliation_tasks(p_now timestamptz default now())
returns setof public.tasks
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.tasks
  where status = 'pending'
     or (
       status in ('claimed', 'running')
       and coalesce(lease_expires_at, '-infinity'::timestamptz) <= p_now
     )
  order by created_at, id;
$$;

revoke all on function public.submit_bridge_task_v2(uuid, text, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.release_staged_bridge_task(uuid) from public, anon, authenticated;
grant execute on function public.submit_bridge_task_v2(uuid, text, text, jsonb, jsonb, text) to service_role;
grant execute on function public.release_staged_bridge_task(uuid) to service_role;
