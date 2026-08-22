import { defineChannelPluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { supabaseBridgePlugin } from "./src/channel.js";
import {
  configureBridgeRuntime,
  handleBridgeAgentEvent,
  stopAllBridgeAccounts,
} from "./src/runtime-registry.js";

const supabaseBridgeEntry: OpenClawPluginDefinition = defineChannelPluginEntry({
  id: "supabase-bridge",
  name: "Supabase Bridge",
  description: "Durable Supabase mailbox, run ledger, event stream, and report channel for OpenClaw.",
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
