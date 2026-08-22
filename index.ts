import { defineChannelPluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { supabaseBridgePlugin } from "./src/channel.js";
import {
  configureBridgeRuntime,
  handleBridgeAgentEvent,
  handleBridgeHook,
  stopAllBridgeAccounts,
} from "./src/runtime-registry.js";

const supabaseBridgeEntry: OpenClawPluginDefinition = defineChannelPluginEntry({
  id: "supabase-bridge",
  name: "Supabase Control Plane Bridge",
  description: "Durable Supabase task mailbox, run ledger, and read-only OpenClaw operational uplink.",
  plugin: supabaseBridgePlugin,
  registerFull(api) {
    configureBridgeRuntime(api);
    api.agent.events.registerAgentEventSubscription({
      id: "supabase-bridge-events",
      description: "Persist incremental events only for Supabase Bridge-originated runs.",
      streams: [
        "lifecycle",
        "tool",
        "assistant",
        "error",
        "item",
        "plan",
        "approval",
        "command_output",
        "patch",
        "compaction",
        "thinking",
        "acp",
        "custom",
      ],
      async handle(event) {
        await handleBridgeAgentEvent(event);
      },
    });
    api.on("llm_output", (event, context) => handleBridgeHook("llm_output", event, context));
    api.on("agent_end", (event, context) => handleBridgeHook("agent_end", event, context));
    api.on("after_tool_call", (event, context) => handleBridgeHook("after_tool_call", event, context));
    api.on("session_start", (event, context) => handleBridgeHook("session_start", event, context));
    api.on("session_end", (event, context) => handleBridgeHook("session_end", event, context));
    api.on("subagent_spawned", (event, context) => handleBridgeHook("subagent_spawned", event, context));
    api.on("subagent_ended", (event, context) => handleBridgeHook("subagent_ended", event, context));
    api.on("cron_changed", (event, context) => handleBridgeHook("cron_changed", event, context));
    api.on("gateway_start", (event, context) => handleBridgeHook("gateway_start", event, context));
    api.on("gateway_stop", (event, context) => handleBridgeHook("gateway_stop", event, context));
    api.lifecycle.registerRuntimeLifecycle({
      id: "supabase-bridge-cleanup",
      description: "Stop Supabase listeners, timers, and event buffers on plugin or Gateway cleanup.",
      async cleanup() {
        await stopAllBridgeAccounts();
      },
    });
  },
});

export default supabaseBridgeEntry;
