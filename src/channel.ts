import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID, isBridgeConfigured, resolvePluginConfig } from "./config.js";

export interface ResolvedBridgeAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  credentialResolved: boolean;
  workerId: string;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedBridgeAccount {
  const config = resolvePluginConfig(cfg);
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    enabled: config.enabled,
    configured: isBridgeConfigured(cfg),
    credentialResolved: Boolean(config.supabaseCredential),
    workerId: config.workerId,
  };
}

export const supabaseBridgePlugin: ChannelPlugin<ResolvedBridgeAccount> = {
  id: "supabase-bridge",
  meta: {
    id: "supabase-bridge",
    label: "Supabase Task Mailbox",
    selectionLabel: "Supabase Task Mailbox (one worker account)",
    docsPath: "/plugins/supabase-bridge",
    docsLabel: "Supabase Control Plane Bridge",
    blurb: "Durable Chatter-to-OpenClaw task mailbox plus read-only operational telemetry.",
    markdownCapable: true,
    showConfigured: true,
    showInSetup: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    blockStreaming: true,
  },
  reload: {
    configPrefixes: ["plugins.entries.supabase-bridge", "channels.supabase-bridge"],
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    resolveAccount,
    inspectAccount(cfg, accountId) {
      const account = resolveAccount(cfg, accountId);
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        credentialStatus: account.credentialResolved ? "available" : account.configured ? "configured-secret-ref" : "missing",
        workerId: account.workerId,
      };
    },
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    disabledReason: () => "Enable plugins.entries.supabase-bridge.config.enabled and channels.supabase-bridge.enabled",
    unconfiguredReason: () => "Configure supabaseUrl and a SecretRef-backed supabaseCredential",
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      connected: false,
      running: false,
      credentialSource: account.credentialResolved ? "SecretRef/runtime" : "missing",
    }),
    hasConfiguredState: ({ cfg }) => isBridgeConfigured(cfg),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: false,
      configured: false,
      running: false,
      connected: false,
    },
  },
  gateway: {
    async startAccount(ctx) {
      ctx.setStatus({
        ...ctx.getStatus(),
        accountId: ctx.accountId,
        enabled: true,
        configured: true,
        running: true,
        connected: false,
        lastStartAt: Date.now(),
      });
      const logger = {
        info: (message: string) => ctx.log?.info(message),
        warn: (message: string) => ctx.log?.warn(message),
        error: (message: string) => ctx.log?.error(message),
        debug: (message: string) => ctx.log?.debug?.(message),
      };
      try {
        const runtime = await import("./runtime-registry.js");
        ctx.setStatus({ ...ctx.getStatus(), connected: true, lastConnectedAt: Date.now() });
        await runtime.startBridgeAccount({
          accountId: ctx.accountId,
          cfg: ctx.cfg,
          abortSignal: ctx.abortSignal,
          logger,
        });
      } catch (error) {
        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          connected: false,
          lastError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async stopAccount(ctx) {
      const runtime = await import("./runtime-registry.js");
      await runtime.stopBridgeAccount(ctx.accountId);
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 64_000,
    deliveryCapabilities: { durableFinal: { text: true } },
    resolveTarget: ({ to }) => to?.trim()
      ? { ok: true, to: to.trim() }
      : { ok: false, error: new Error("Supabase Bridge outbound target must be a task id") },
    async sendText(ctx) {
      const runtime = await import("./runtime-registry.js");
      const messageId = await runtime.deliverBridgeOutbound(ctx.to, ctx.text);
      return {
        channel: "supabase-bridge",
        messageId,
        conversationId: ctx.to,
        timestamp: Date.now(),
      };
    },
  },
};
