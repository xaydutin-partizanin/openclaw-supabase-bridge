import type { OpenClawConfig, OpenClawPluginApi, ProviderUsageSnapshot } from "openclaw/plugin-sdk/core";
import { fetchCodexUsage, fetchDeepSeekUsage } from "openclaw/plugin-sdk/provider-usage";
import { resolvePluginConfig } from "./config.js";
import { collectCursorQuotaStatus } from "./cursor-quota/index.js";
import { errorMessage } from "./object-utils.js";
import { sanitizeEventData } from "./sanitizer.js";
import type { InventoryIds, InventorySnapshot, Json, QuotaStatus } from "./types.js";

function quotaPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function quotaIdentity(provider: string, account: string, bucket: string): string {
  return `${provider}:${account}:${bucket}`;
}

export function mapUsageSnapshot(input: {
  providerKey: string;
  providerId: string;
  accountKey?: string;
  snapshot: ProviderUsageSnapshot;
  checkedAt: string;
  source: string;
}): QuotaStatus[] {
  const accountKey = input.accountKey ?? "default";
  const rows: QuotaStatus[] = [];
  for (const window of input.snapshot.windows) {
    const bucket = `window:${quotaPart(window.label)}`;
    rows.push({
      quotaIdentity: quotaIdentity(input.providerKey, accountKey, bucket),
      providerId: input.providerId,
      providerKey: input.providerKey,
      configId: null,
      configKey: null,
      accountKey,
      quotaKey: bucket,
      remaining: Math.max(0, 100 - window.usedPercent),
      limitValue: 100,
      unit: "percent",
      resetAt: window.resetAt ? new Date(window.resetAt).toISOString() : null,
      checkedAt: input.checkedAt,
      status: input.snapshot.error ? "error" : "ok",
      source: input.source,
      other: {
        label: window.label,
        used_percent: window.usedPercent,
        ...(input.snapshot.plan ? { plan: input.snapshot.plan } : {}),
        ...(input.snapshot.summary ? { summary: input.snapshot.summary } : {}),
      },
    });
  }
  for (const billing of input.snapshot.billing ?? []) {
    const label = billing.label ?? billing.type;
    const bucket = `${billing.type}:${quotaPart(label)}`;
    let remaining: number | null = null;
    let limit: number | null = null;
    const other: Record<string, Json> = { label, billing_type: billing.type };
    let resetAt: string | null = null;
    if (billing.type === "balance") {
      remaining = billing.amount;
    } else if (billing.type === "budget") {
      remaining = Math.max(0, billing.limit - billing.used);
      limit = billing.limit;
      other.used = billing.used;
      if (billing.period) other.period = billing.period;
      resetAt = billing.resetAt ? new Date(billing.resetAt).toISOString() : null;
    } else {
      other.amount = billing.amount;
      if (billing.period) other.period = billing.period;
      resetAt = billing.resetAt ? new Date(billing.resetAt).toISOString() : null;
    }
    rows.push({
      quotaIdentity: quotaIdentity(input.providerKey, accountKey, bucket),
      providerId: input.providerId,
      providerKey: input.providerKey,
      configId: null,
      configKey: null,
      accountKey,
      quotaKey: bucket,
      remaining,
      limitValue: limit,
      unit: billing.unit,
      resetAt,
      checkedAt: input.checkedAt,
      status: input.snapshot.error ? "error" : "ok",
      source: input.source,
      other,
    });
  }
  if (!rows.length) {
    rows.push({
      quotaIdentity: quotaIdentity(input.providerKey, accountKey, "provider"),
      providerId: input.providerId,
      providerKey: input.providerKey,
      configId: null,
      configKey: null,
      accountKey,
      quotaKey: "provider",
      remaining: null,
      limitValue: null,
      unit: null,
      resetAt: null,
      checkedAt: input.checkedAt,
      status: input.snapshot.error ? "error" : "unknown",
      source: input.source,
      other: input.snapshot.error ? { error: input.snapshot.error } : { reason: "no_quota_buckets_returned" },
    });
  }
  return rows;
}

export function unsupportedQuotaRow(providerKey: string, providerId: string, checkedAt: string): QuotaStatus {
  return {
    quotaIdentity: quotaIdentity(providerKey, "default", "provider"),
    providerId,
    providerKey,
    configId: null,
    configKey: null,
    accountKey: "default",
    quotaKey: "provider",
    remaining: null,
    limitValue: null,
    unit: null,
    resetAt: null,
    checkedAt,
    status: "unsupported",
    source: "unavailable",
    other: { reason: "no_authoritative_quota_adapter" },
  };
}

export function errorQuotaRow(
  providerKey: string,
  providerId: string,
  checkedAt: string,
  error: unknown,
): QuotaStatus {
  const safe = sanitizeEventData({ error: errorMessage(error) }, 4_096).value;
  return {
    quotaIdentity: quotaIdentity(providerKey, "default", "provider"),
    providerId,
    providerKey,
    configId: null,
    configKey: null,
    accountKey: "default",
    quotaKey: "provider",
    remaining: null,
    limitValue: null,
    unit: null,
    resetAt: null,
    checkedAt,
    status: "error",
    source: "provider_api",
    other: safe,
  };
}

export class QuotaCollector {
  readonly #api: OpenClawPluginApi;
  readonly #cfg: OpenClawConfig;

  constructor(api: OpenClawPluginApi, cfg: OpenClawConfig) {
    this.#api = api;
    this.#cfg = cfg;
  }

  async collect(inventory: InventorySnapshot, ids: InventoryIds): Promise<QuotaStatus[]> {
    const checkedAt = new Date().toISOString();
    const rows: QuotaStatus[] = [];
    for (const provider of inventory.providers) {
      const providerId = ids.providerIds.get(provider.providerKey);
      if (!providerId) continue;
      if (!provider.available) {
        rows.push({ ...unsupportedQuotaRow(provider.providerKey, providerId, checkedAt), status: "unknown", other: { reason: "provider_unavailable" } });
        continue;
      }
      if (provider.providerKey === "cursor") {
        try {
          const pluginConfig = resolvePluginConfig(this.#cfg);
          rows.push(
            ...(await collectCursorQuotaStatus({
              providerId,
              checkedAt,
              userApiKey: pluginConfig.cursorUserApiKey,
            })),
          );
        } catch (error) {
          rows.push(errorQuotaRow(provider.providerKey, providerId, checkedAt, error));
        }
        continue;
      }
      if (provider.providerKey !== "openai" && provider.providerKey !== "deepseek") {
        rows.push(unsupportedQuotaRow(provider.providerKey, providerId, checkedAt));
        continue;
      }
      try {
        const auth = await this.#api.runtime.modelAuth.resolveApiKeyForProvider({
          provider: provider.providerKey,
          cfg: this.#cfg,
        });
        if (!auth.apiKey) {
          rows.push({ ...unsupportedQuotaRow(provider.providerKey, providerId, checkedAt), status: "unknown", other: { reason: "usage_auth_unavailable" } });
          continue;
        }
        const snapshot = provider.providerKey === "openai"
          ? await fetchCodexUsage(auth.apiKey, undefined, 10_000, fetch)
          : await fetchDeepSeekUsage(auth.apiKey, 10_000, fetch);
        rows.push(...mapUsageSnapshot({
          providerKey: provider.providerKey,
          providerId,
          snapshot,
          checkedAt,
          source: "provider_api",
        }));
      } catch (error) {
        rows.push(errorQuotaRow(provider.providerKey, providerId, checkedAt, error));
      }
    }
    return rows;
  }
}
