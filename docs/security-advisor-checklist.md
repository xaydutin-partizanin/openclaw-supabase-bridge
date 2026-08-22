# Post-migration security checklist

Run this against the intended Supabase project after applying the additive migration:

- Confirm RLS is enabled on every table added by `202608220002_openclaw_control_plane_uplink.sql`.
- Confirm `anon` and `authenticated` have no table/view access and no execute access to bridge RPCs.
- Confirm only the backend role can call `submit_bridge_task_v2`, `start_bridge_run_v2`, and `record_bridge_error_rollup`.
- Confirm no permissive public policies were added.
- Confirm `tasks` remains the only bridge table added to the Realtime publication; telemetry does not require Realtime.
- Query Supabase security/performance advisors and resolve any exposed-function, missing-RLS, or unsafe-search-path finding.
- Verify security-definer functions set `search_path = public` and use fixed table names.
- Verify the local credential remains an OpenClaw SecretRef outside agent workspaces and is absent from Git/history/logs.
- Sample telemetry to confirm prompts, transcripts, cookies, tokens, environment values, command bodies, memory contents, browser contents, IP addresses, and device key material are absent.
- Replace broad `service_role` usage with a dedicated least-privilege backend role/key when the project’s auth design permits it.
