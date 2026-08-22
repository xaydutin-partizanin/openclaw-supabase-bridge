import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { supabaseBridgePlugin } from "./src/channel.js";

export default defineSetupPluginEntry(supabaseBridgePlugin);
