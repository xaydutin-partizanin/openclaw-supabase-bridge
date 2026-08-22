import os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { asBoolean, asBoundedInteger, asRecord, asString, isRecord } from "./object-utils.js";
import type { PluginConfig } from "./types.js";

export const PLUGIN_ID = "supabase-bridge";
export const DEFAULT_ACCOUNT_ID = "default";

function readPluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const root = asRecord(cfg);
  const plugins = asRecord(root.plugins);
  const entries = asRecord(plugins.entries);
  const entry = asRecord(entries[PLUGIN_ID]);
  return asRecord(entry.config);
}

function readChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const root = asRecord(cfg);
  return asRecord(asRecord(root.channels)[PLUGIN_ID]);
}

function defaultWorkerId(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `openclaw-${host || "local"}`;
}

export function resolvePluginConfig(cfg: OpenClawConfig): PluginConfig {
  const raw = readPluginConfig(cfg);
  const channel = readChannelConfig(cfg);
  const credential = raw.supabaseCredential;
  const resolvedCredential = asString(credential);
  const credentialConfigured = resolvedCredential !== null || isRecord(credential);
  const enabled = asBoolean(raw.enabled, false) && asBoolean(channel.enabled, false);

  return {
    enabled,
    supabaseUrl: asString(raw.supabaseUrl),
    supabaseCredential: resolvedCredential,
    credentialConfigured,
    workerId: asString(raw.workerId) ?? defaultWorkerId(),
    quotaRefreshIntervalMinutes: asBoundedInteger(raw.quotaRefreshIntervalMinutes, 15, 1, 1440),
    eventLoggingEnabled: asBoolean(raw.eventLoggingEnabled, true),
    eventMaxPayloadBytes: asBoundedInteger(raw.eventMaxPayloadBytes, 65_536, 1_024, 1_048_576),
    leaseDurationSeconds: asBoundedInteger(raw.leaseDurationSeconds, 900, 60, 86_400),
  };
}

export function isBridgeConfigured(cfg: OpenClawConfig): boolean {
  const config = resolvePluginConfig(cfg);
  return Boolean(config.supabaseUrl && config.credentialConfigured);
}

export function assertRunnableConfig(config: PluginConfig): asserts config is PluginConfig & {
  supabaseUrl: string;
  supabaseCredential: string;
} {
  if (!config.enabled) throw new Error("Supabase Bridge is disabled");
  if (!config.supabaseUrl) throw new Error("Supabase Bridge requires supabaseUrl");
  if (!config.supabaseCredential) {
    throw new Error("Supabase Bridge credential is missing or its SecretRef did not resolve");
  }
}
