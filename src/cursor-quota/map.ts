import type { Json, QuotaStatus } from "../types.js";
import type { CursorAuthSource } from "./auth.js";
import type { CursorQuotaObservation } from "./client.js";

const SOURCE = "cursor_internal_api";

function quotaIdentity(account: string, bucket: string): string {
  return `cursor:${account}:${bucket}`;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function msTimestampToIso(value: unknown): string | null {
  const ms = asFiniteNumber(value);
  if (ms === null || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function percentWindowRow(input: {
  accountKey: string;
  providerId: string;
  checkedAt: string;
  quotaKey: string;
  label: string;
  usedPercent: number;
  resetAt: string | null;
  other: Record<string, Json>;
}): QuotaStatus {
  const used = clampPercent(input.usedPercent);
  return {
    quotaIdentity: quotaIdentity(input.accountKey, input.quotaKey),
    providerId: input.providerId,
    providerKey: "cursor",
    configId: null,
    configKey: null,
    accountKey: input.accountKey,
    quotaKey: input.quotaKey,
    remaining: Math.max(0, 100 - used),
    limitValue: 100,
    unit: "percent",
    resetAt: input.resetAt,
    checkedAt: input.checkedAt,
    status: "ok",
    source: SOURCE,
    other: {
      label: input.label,
      used_percent: used,
      ...input.other,
    },
  };
}

/**
 * Map Cursor DashboardService observations into bridge quota_status rows.
 * Does not invent missing percentages or limits.
 */
export function mapCursorQuotaObservation(input: {
  observation: CursorQuotaObservation;
  providerId: string;
  checkedAt: string;
  accountKey?: string;
}): QuotaStatus[] {
  const accountKey = input.accountKey ?? "default";
  const usage = input.observation.usage;
  const planUsage = usage.planUsage ?? {};
  const periodStart = msTimestampToIso(usage.billingCycleStart);
  const periodEnd =
    msTimestampToIso(usage.billingCycleEnd) ??
    msTimestampToIso(input.observation.plan?.billingCycleEnd);

  const sharedOther: Record<string, Json> = {
    authority: "authenticated_cursor_dashboard_observation",
    provenance: SOURCE,
    auth_source: input.observation.authSource,
    ...(periodStart ? { period_start: periodStart } : {}),
    ...(periodEnd ? { period_end: periodEnd } : {}),
  };

  if (input.observation.plan?.planName) {
    sharedOther.plan = input.observation.plan.planName;
  }
  if (input.observation.plan?.price) {
    sharedOther.plan_price = input.observation.plan.price;
  }
  const includedLimit = asFiniteNumber(planUsage.limit ?? input.observation.plan?.includedAmountCents);
  const includedSpend = asFiniteNumber(planUsage.includedSpend);
  const bonusSpend = asFiniteNumber(planUsage.bonusSpend);
  const totalSpend = asFiniteNumber(planUsage.totalSpend);
  if (includedLimit !== null) sharedOther.included_limit_cents = includedLimit;
  if (includedSpend !== null) sharedOther.included_spend_cents = includedSpend;
  if (bonusSpend !== null) sharedOther.bonus_spend_cents = bonusSpend;
  if (totalSpend !== null) sharedOther.total_spend_cents = totalSpend;
  if (typeof planUsage.remainingBonus === "boolean") {
    sharedOther.remaining_bonus = planUsage.remainingBonus;
  }
  if (typeof usage.enabled === "boolean") {
    // Field meaning is provider-defined; store as observed without inventing on-demand state.
    sharedOther.usage_enabled_flag = usage.enabled;
  }
  if (typeof usage.displayMessage === "string" && usage.displayMessage.trim()) {
    sharedOther.display_message = usage.displayMessage.slice(0, 240);
  }
  if (input.observation.usageLimitPolicy) {
    const policy = input.observation.usageLimitPolicy;
    sharedOther.on_demand_policy = {
      can_adjust_on_demand: Boolean(policy.canAdjustOnDemand),
      can_configure_spend_limit: Boolean(policy.canConfigureSpendLimit),
      ...(asFiniteNumber(policy.onDemandMinCents) !== null
        ? { on_demand_min_cents: asFiniteNumber(policy.onDemandMinCents) }
        : {}),
      ...(asFiniteNumber(policy.onDemandMaxCents) !== null
        ? { on_demand_max_cents: asFiniteNumber(policy.onDemandMaxCents) }
        : {}),
      ...(asFiniteNumber(policy.recommendedOnDemandLimitCents) !== null
        ? { recommended_on_demand_limit_cents: asFiniteNumber(policy.recommendedOnDemandLimitCents) }
        : {}),
    };
  }
  if (usage.spendLimitUsage && typeof usage.spendLimitUsage === "object") {
    const limitType = (usage.spendLimitUsage as Record<string, unknown>).limitType;
    if (typeof limitType === "string") {
      sharedOther.spend_limit_type = limitType;
    }
  }

  const rows: QuotaStatus[] = [];
  const autoPercent = asFiniteNumber(planUsage.autoPercentUsed);
  const apiPercent = asFiniteNumber(planUsage.apiPercentUsed);
  const totalPercent = asFiniteNumber(planUsage.totalPercentUsed);

  if (autoPercent !== null) {
    rows.push(
      percentWindowRow({
        accountKey,
        providerId: input.providerId,
        checkedAt: input.checkedAt,
        quotaKey: "window:cursor-models",
        label: "Cursor Models",
        usedPercent: autoPercent,
        resetAt: periodEnd,
        other: sharedOther,
      }),
    );
  }
  if (apiPercent !== null) {
    rows.push(
      percentWindowRow({
        accountKey,
        providerId: input.providerId,
        checkedAt: input.checkedAt,
        quotaKey: "window:other-models",
        label: "Other Models",
        usedPercent: apiPercent,
        resetAt: periodEnd,
        other: sharedOther,
      }),
    );
  }
  if (totalPercent !== null) {
    rows.push(
      percentWindowRow({
        accountKey,
        providerId: input.providerId,
        checkedAt: input.checkedAt,
        quotaKey: "window:total",
        label: "Total included usage",
        usedPercent: totalPercent,
        resetAt: periodEnd,
        other: sharedOther,
      }),
    );
  }

  // Dollar included allowance as an explicit budget bucket when cents are exposed.
  if (includedLimit !== null && includedSpend !== null) {
    rows.push({
      quotaIdentity: quotaIdentity(accountKey, "budget:included"),
      providerId: input.providerId,
      providerKey: "cursor",
      configId: null,
      configKey: null,
      accountKey,
      quotaKey: "budget:included",
      remaining: Math.max(0, includedLimit - Math.min(includedSpend, includedLimit)),
      limitValue: includedLimit,
      unit: "USD_cents",
      resetAt: periodEnd,
      checkedAt: input.checkedAt,
      status: "ok",
      source: SOURCE,
      other: {
        label: "Included plan allowance",
        billing_type: "budget",
        used: Math.min(includedSpend, includedLimit),
        ...sharedOther,
      },
    });
  }

  if (!rows.length) {
    rows.push({
      quotaIdentity: quotaIdentity(accountKey, "provider"),
      providerId: input.providerId,
      providerKey: "cursor",
      configId: null,
      configKey: null,
      accountKey,
      quotaKey: "provider",
      remaining: null,
      limitValue: null,
      unit: null,
      resetAt: periodEnd,
      checkedAt: input.checkedAt,
      status: "unknown",
      source: SOURCE,
      other: {
        reason: "cursor_usage_fields_missing",
        auth_source: input.observation.authSource,
        provenance: SOURCE,
      },
    });
  } else {
    rows.push({
      quotaIdentity: quotaIdentity(accountKey, "provider"),
      providerId: input.providerId,
      providerKey: "cursor",
      configId: null,
      configKey: null,
      accountKey,
      quotaKey: "provider",
      remaining: null,
      limitValue: null,
      unit: null,
      resetAt: periodEnd,
      checkedAt: input.checkedAt,
      status: "ok",
      source: SOURCE,
      other: {
        summary: "cursor_usage_pools",
        pool_count: rows.length,
        auth_source: input.observation.authSource,
        provenance: SOURCE,
        ...(input.observation.plan?.planName ? { plan: input.observation.plan.planName } : {}),
      },
    });
  }

  return rows;
}

export function cursorAuthUnavailableRow(
  providerId: string,
  checkedAt: string,
  reason: string,
  authSourceAttempted?: CursorAuthSource | null,
  detail?: string,
): QuotaStatus {
  return {
    quotaIdentity: quotaIdentity("default", "provider"),
    providerId,
    providerKey: "cursor",
    configId: null,
    configKey: null,
    accountKey: "default",
    quotaKey: "provider",
    remaining: null,
    limitValue: null,
    unit: null,
    resetAt: null,
    checkedAt,
    status: reason === "cursor_auth_unavailable" ? "unsupported" : "error",
    source: reason === "cursor_auth_unavailable" ? "unavailable" : SOURCE,
    other: {
      reason,
      provenance: SOURCE,
      ...(authSourceAttempted ? { auth_source: authSourceAttempted } : {}),
      ...(detail ? { detail } : {}),
    },
  };
}
