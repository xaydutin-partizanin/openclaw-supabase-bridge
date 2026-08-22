import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { BridgeController, type BridgeLogger } from "./controller.js";
import { resolvePluginConfig } from "./config.js";
import type { OpenClawAgentEvent } from "./types.js";

let pluginApi: OpenClawPluginApi | null = null;
const controllers = new Map<string, BridgeController>();

function requireApi(): OpenClawPluginApi {
  if (!pluginApi) throw new Error("Supabase Bridge runtime was not registered with OpenClaw");
  return pluginApi;
}

export function configureBridgeRuntime(api: OpenClawPluginApi): void {
  pluginApi = api;
}

export async function startBridgeAccount(input: {
  accountId: string;
  cfg: OpenClawConfig;
  abortSignal: AbortSignal;
  logger?: BridgeLogger;
}): Promise<void> {
  const api = requireApi();
  const existing = controllers.get(input.accountId);
  if (existing) await existing.stop();
  const logger = input.logger ?? api.logger;
  const controller = new BridgeController({
    api,
    cfg: input.cfg,
    accountId: input.accountId,
    config: resolvePluginConfig(input.cfg),
    logger,
  });
  controllers.set(input.accountId, controller);
  try {
    await controller.start(input.abortSignal);
    if (!input.abortSignal.aborted) {
      await new Promise<void>((resolve) => input.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    await controller.stop();
    if (controllers.get(input.accountId) === controller) controllers.delete(input.accountId);
  }
}

export async function stopBridgeAccount(accountId: string): Promise<void> {
  const controller = controllers.get(accountId);
  if (!controller) return;
  controllers.delete(accountId);
  await controller.stop();
}

export async function stopAllBridgeAccounts(): Promise<void> {
  const active = [...controllers.values()];
  controllers.clear();
  await Promise.all(active.map(async (controller) => controller.stop()));
}

export async function handleBridgeAgentEvent(event: OpenClawAgentEvent): Promise<void> {
  await Promise.all([...controllers.values()].map(async (controller) => controller.handleAgentEvent(event)));
}

export async function deliverBridgeOutbound(target: string, text: string): Promise<string> {
  for (const controller of controllers.values()) {
    if (controller.started) return controller.recordOutbound(target, text);
  }
  throw new Error("Supabase Bridge has no running account");
}
