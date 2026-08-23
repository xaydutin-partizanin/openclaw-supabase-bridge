import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { asRecord, asString } from "../object-utils.js";

export interface ConfiguredAgent {
  id: string;
  name: string | null;
  isDefault: boolean;
  workspacePath: string;
  runtimeId: "native" | "acp";
  runtimeSource: string;
  runtimeConfig: Record<string, unknown>;
  primaryModelRef: string | null;
  thinkingDefault: string | null;
}

function configuredPrimaryModel(entry: Record<string, unknown>, defaults: Record<string, unknown>): string | null {
  const direct = asString(entry.model);
  if (direct) return direct;
  const perAgent = asString(asRecord(entry.model).primary);
  if (perAgent) return perAgent;
  return asString(asRecord(defaults.model).primary) ?? null;
}

export function listConfiguredAgents(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
): ConfiguredAgent[] {
  const root = asRecord(cfg);
  const agentsRoot = asRecord(root.agents);
  const defaults = asRecord(agentsRoot.defaults);
  const configured = Array.isArray(agentsRoot.list) ? agentsRoot.list.map(asRecord) : [];
  const entries = configured.length ? configured : [{ id: "main" }];
  const defaultId = entries.some((entry) => asString(entry.id) === "main")
    ? "main"
    : asString(entries[0]?.id) ?? "main";

  return entries.flatMap((entry): ConfiguredAgent[] => {
    const id = asString(entry.id);
    if (!id) return [];
    const runtimeConfig = asRecord(entry.runtime);
    const runtimeId = asString(runtimeConfig.type) === "acp" ? "acp" : "native";
    let workspacePath = asString(entry.workspace);
    if (!workspacePath) {
      try {
        workspacePath = api.runtime.agent.resolveAgentWorkspaceDir(cfg, id);
      } catch {
        workspacePath = asString(defaults.workspace);
      }
    }
    let identityName: string | null = null;
    try {
      identityName = asString(api.runtime.agent.resolveAgentIdentity(cfg, id)?.name) ?? null;
    } catch {
      // Identity is optional; configured name remains authoritative when present.
    }
    return [{
      id,
      name: asString(entry.name) ?? identityName,
      isDefault: id === defaultId,
      workspacePath: workspacePath ?? "",
      runtimeId,
      runtimeSource: "plugin_config",
      runtimeConfig,
      primaryModelRef: configuredPrimaryModel(entry, defaults),
      thinkingDefault: asString(entry.thinkingDefault) ?? asString(defaults.thinkingDefault) ?? null,
    }];
  });
}

export function listConfiguredModelRefs(cfg: OpenClawConfig): string[] {
  const agentsRoot = asRecord(asRecord(cfg).agents);
  const defaults = asRecord(agentsRoot.defaults);
  const refs = new Set<string>();
  const primary = asString(asRecord(defaults.model).primary);
  if (primary) refs.add(primary);
  for (const ref of Object.keys(asRecord(defaults.models))) {
    if (ref.includes("/")) refs.add(ref);
  }
  for (const entry of Array.isArray(agentsRoot.list) ? agentsRoot.list.map(asRecord) : []) {
    const direct = asString(entry.model) ?? asString(asRecord(entry.model).primary);
    if (direct?.includes("/")) refs.add(direct);
  }
  return [...refs];
}

export function agentIdFromSessionKey(sessionKey: string): string {
  return /^agent:([^:]+):/.exec(sessionKey)?.[1] ?? "main";
}

export function listAllSessionEntries(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
): ReturnType<OpenClawPluginApi["runtime"]["agent"]["session"]["listSessionEntries"]> {
  const entries = new Map<string, ReturnType<OpenClawPluginApi["runtime"]["agent"]["session"]["listSessionEntries"]>[number]>();
  for (const agent of listConfiguredAgents(api, cfg)) {
    for (const summary of api.runtime.agent.session.listSessionEntries({ agentId: agent.id })) {
      entries.set(summary.sessionKey, summary);
    }
  }
  return [...entries.values()];
}
