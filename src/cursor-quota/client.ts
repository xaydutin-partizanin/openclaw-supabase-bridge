import type { CursorAuthSource } from "./auth.js";

const DASHBOARD_BASE = "https://api2.cursor.sh/aiserver.v1.DashboardService";

export interface CursorPlanUsage {
  totalSpend?: number;
  includedSpend?: number;
  bonusSpend?: number;
  limit?: number;
  remainingBonus?: boolean;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  totalPercentUsed?: number;
  bonusTooltip?: string;
}

export interface CursorCurrentPeriodUsage {
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: CursorPlanUsage;
  spendLimitUsage?: Record<string, unknown>;
  enabled?: boolean;
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
  displayThreshold?: number;
  autoBucketModels?: string[];
}

export interface CursorPlanInfo {
  planName?: string;
  includedAmountCents?: number;
  price?: string;
  billingCycleEnd?: string | number;
  planOwner?: string;
}

export interface CursorUsageLimitPolicy {
  canAdjustOnDemand?: boolean;
  canConfigureSpendLimit?: boolean;
  onDemandMaxCents?: string | number;
  onDemandMinCents?: string | number;
  recommendedOnDemandLimitCents?: string | number;
}

export type CursorRpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; status?: number; detail?: string };

async function postJson<T>(
  rpcName: string,
  accessToken: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<CursorRpcResult<T>> {
  try {
    const response = await fetchImpl(`${DASHBOARD_BASE}/${rpcName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, reason: "cursor_rpc_non_json", status: response.status };
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string"
          ? (parsed as { message: string }).message
          : `http_${response.status}`;
      // Strip anything that looks like a bearer fragment from error messages.
      const safe = message.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 200);
      return {
        ok: false,
        reason: response.status === 401 || response.status === 403 ? "cursor_auth_rejected" : "cursor_rpc_http_error",
        status: response.status,
        detail: safe,
      };
    }
    return { ok: true, data: parsed as T };
  } catch (error) {
    return {
      ok: false,
      reason: "cursor_rpc_network_error",
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown_error",
    };
  }
}

export async function fetchCurrentPeriodUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorRpcResult<CursorCurrentPeriodUsage>> {
  return postJson<CursorCurrentPeriodUsage>("GetCurrentPeriodUsage", accessToken, {}, fetchImpl);
}

export async function fetchPlanInfo(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorRpcResult<{ planInfo?: CursorPlanInfo }>> {
  return postJson<{ planInfo?: CursorPlanInfo }>("GetPlanInfo", accessToken, {}, fetchImpl);
}

export async function fetchUsageLimitPolicy(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorRpcResult<{ usageLimitPolicyStatus?: CursorUsageLimitPolicy }>> {
  return postJson<{ usageLimitPolicyStatus?: CursorUsageLimitPolicy }>(
    "GetUsageLimitStatusAndActiveGrants",
    accessToken,
    {},
    fetchImpl,
  );
}

export interface CursorQuotaObservation {
  authSource: CursorAuthSource;
  usage: CursorCurrentPeriodUsage;
  plan?: CursorPlanInfo;
  usageLimitPolicy?: CursorUsageLimitPolicy;
}

export async function collectCursorQuotaObservation(input: {
  accessToken: string;
  authSource: CursorAuthSource;
  fetchImpl?: typeof fetch;
}): Promise<CursorRpcResult<CursorQuotaObservation>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const usageResult = await fetchCurrentPeriodUsage(input.accessToken, fetchImpl);
  if (!usageResult.ok) return usageResult;

  const [planResult, policyResult] = await Promise.all([
    fetchPlanInfo(input.accessToken, fetchImpl),
    fetchUsageLimitPolicy(input.accessToken, fetchImpl),
  ]);

  return {
    ok: true,
    data: {
      authSource: input.authSource,
      usage: usageResult.data,
      ...(planResult.ok && planResult.data.planInfo ? { plan: planResult.data.planInfo } : {}),
      ...(policyResult.ok && policyResult.data.usageLimitPolicyStatus
        ? { usageLimitPolicy: policyResult.data.usageLimitPolicyStatus }
        : {}),
    },
  };
}
