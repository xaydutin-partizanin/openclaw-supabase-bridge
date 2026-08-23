import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCursorQuotaStatus,
  exchangeUserApiKey,
  mapCursorQuotaObservation,
  readAccessTokenFromAuthJson,
  resolveCursorAccessToken,
} from "../src/cursor-quota/index.js";
import { errorQuotaRow, mapUsageSnapshot, unsupportedQuotaRow } from "../src/quota.js";
import { sanitizeEventData } from "../src/sanitizer.js";

const checkedAt = "2026-08-23T16:00:00.000Z";
const periodStartMs = "1785053875000";
const periodEndMs = "1787732275000";

function fixtureUsage(overrides: Record<string, unknown> = {}) {
  return {
    billingCycleStart: periodStartMs,
    billingCycleEnd: periodEndMs,
    enabled: true,
    displayMessage: "You've hit your usage limit",
    planUsage: {
      autoPercentUsed: 87.9,
      apiPercentUsed: 0,
      totalPercentUsed: 76.4,
      includedSpend: 2000,
      bonusSpend: 24000,
      totalSpend: 26000,
      limit: 2000,
      remainingBonus: false,
    },
    spendLimitUsage: { limitType: "user" },
    ...overrides,
  };
}

describe("cursor quota mapping", () => {
  it("maps Cursor Models, Other Models, total, included budget, and reset timestamps", () => {
    const rows = mapCursorQuotaObservation({
      providerId: "provider-cursor",
      checkedAt,
      observation: {
        authSource: "cursor_auth_json",
        usage: fixtureUsage(),
        plan: {
          planName: "Pro",
          price: "$20/mo",
          includedAmountCents: 2000,
          billingCycleEnd: periodEndMs,
        },
        usageLimitPolicy: {
          canAdjustOnDemand: true,
          canConfigureSpendLimit: true,
          onDemandMinCents: "5000",
          onDemandMaxCents: "20000",
        },
      },
    });

    const cursorModels = rows.find((row) => row.quotaKey === "window:cursor-models");
    const otherModels = rows.find((row) => row.quotaKey === "window:other-models");
    const total = rows.find((row) => row.quotaKey === "window:total");
    const included = rows.find((row) => row.quotaKey === "budget:included");

    expect(cursorModels).toMatchObject({
      remaining: expect.closeTo(12.1, 5),
      limitValue: 100,
      unit: "percent",
      status: "ok",
      source: "cursor_internal_api",
      resetAt: "2026-08-26T08:17:55.000Z",
    });
    expect(cursorModels?.other).toMatchObject({
      label: "Cursor Models",
      used_percent: 87.9,
      plan: "Pro",
      period_start: "2026-07-26T08:17:55.000Z",
      auth_source: "cursor_auth_json",
      provenance: "cursor_internal_api",
    });
    expect(otherModels).toMatchObject({ remaining: 100, other: { label: "Other Models", used_percent: 0 } });
    expect(total).toMatchObject({ remaining: expect.closeTo(23.6, 5) });
    expect(included).toMatchObject({
      remaining: 0,
      limitValue: 2000,
      unit: "USD_cents",
    });
    expect(included?.other.on_demand_policy).toMatchObject({ can_adjust_on_demand: true });
    const providerSummary = rows.find((row) => row.quotaKey === "provider");
    expect(providerSummary).toMatchObject({ status: "ok", source: "cursor_internal_api" });
  });

  it("records unknown when usage pools are missing rather than inventing zeros", () => {
    const [row] = mapCursorQuotaObservation({
      providerId: "provider-cursor",
      checkedAt,
      observation: {
        authSource: "cursor_auth_json",
        usage: { billingCycleEnd: periodEndMs, planUsage: {} },
      },
    });
    expect(row).toMatchObject({
      status: "unknown",
      remaining: null,
      other: { reason: "cursor_usage_fields_missing" },
    });
  });

  it("tolerates malformed numeric strings without throwing", () => {
    const rows = mapCursorQuotaObservation({
      providerId: "provider-cursor",
      checkedAt,
      observation: {
        authSource: "user_api_key_exchange",
        usage: {
          billingCycleStart: "not-a-number",
          billingCycleEnd: periodEndMs,
          planUsage: {
            autoPercentUsed: "12.5" as unknown as number,
            apiPercentUsed: "NaN" as unknown as number,
            totalPercentUsed: 40,
            limit: "2000" as unknown as number,
            includedSpend: "500" as unknown as number,
          },
        },
      },
    });
    expect(rows.find((row) => row.quotaKey === "window:cursor-models")?.remaining).toBe(87.5);
    expect(rows.find((row) => row.quotaKey === "window:other-models")).toBeUndefined();
    expect(rows.find((row) => row.quotaKey === "budget:included")?.remaining).toBe(1500);
  });
});

describe("cursor auth resolution", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads access tokens from auth.json without requiring sqlite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cic-cursor-auth-"));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ accessToken: "session-token-value" }), "utf8");
    expect(readAccessTokenFromAuthJson(root)).toBe("session-token-value");
  });

  it("prefers user API key exchange when it succeeds", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: "exchanged-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const result = await resolveCursorAccessToken({
      userApiKey: "key_test",
      appDataRoot: path.join(os.tmpdir(), "missing-cursor-root"),
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, source: "user_api_key_exchange" });
    if (result.ok) expect(result.accessToken).toBe("exchanged-token");
  });

  it("falls back to auth.json when user API key exchange fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cic-cursor-auth-"));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ accessToken: "local-session" }), "utf8");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: "error", message: "Invalid User API Key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const result = await resolveCursorAccessToken({
      userApiKey: "key_bad",
      appDataRoot: root,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, source: "cursor_auth_json" });
    if (result.ok) expect(result.accessToken).toBe("local-session");
  });

  it("reports unsupported when no auth source exists", async () => {
    const rows = await collectCursorQuotaStatus({
      providerId: "provider-cursor",
      checkedAt,
      appDataRoot: path.join(os.tmpdir(), "no-cursor-install"),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "unsupported",
      source: "unavailable",
      remaining: null,
      other: { reason: "cursor_auth_unavailable" },
    });
  });

  it("maps HTTP auth rejection to an error row without leaking bearer material", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cic-cursor-auth-"));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ accessToken: "session-token" }), "utf8");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Bearer super-secret-token rejected" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const rows = await collectCursorQuotaStatus({
      providerId: "provider-cursor",
      checkedAt,
      appDataRoot: root,
      fetchImpl,
    });
    expect(rows[0]?.status).toBe("error");
    expect(JSON.stringify(rows[0]?.other)).not.toContain("super-secret-token");
    expect(JSON.stringify(rows[0]?.other)).toContain("[REDACTED]");
  });

  it("maps network failures to error without inventing remaining quota", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cic-cursor-auth-"));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ accessToken: "session-token" }), "utf8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const rows = await collectCursorQuotaStatus({
      providerId: "provider-cursor",
      checkedAt,
      appDataRoot: root,
      fetchImpl,
    });
    expect(rows[0]).toMatchObject({ status: "error", remaining: null, other: { reason: "cursor_rpc_network_error" } });
  });

  it("exchanges user API keys via Authorization Bearer and empty JSON body", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api2.cursor.sh/auth/exchange_user_api_key");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("{}");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer key_ok");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Accept).toBe("application/json");
      expect(JSON.stringify(init)).not.toContain("userApiKey");
      return new Response(JSON.stringify({ accessToken: "short-lived" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await exchangeUserApiKey("key_ok", fetchImpl);
    expect(result).toMatchObject({ ok: true, source: "user_api_key_exchange" });
    if (result.ok) expect(result.accessToken).toBe("short-lived");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not put the user API key into the JSON body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe("{}");
      expect(String(init?.body)).not.toContain("secret-key-value");
      return new Response(JSON.stringify({ message: "Invalid User API Key" }), { status: 401 });
    });
    const result = await exchangeUserApiKey("secret-key-value", fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key-value");
  });
});

describe("end-to-end cursor collect with mocked dashboard", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("produces ok pool rows from a valid current-period response", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cic-cursor-auth-"));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ accessToken: "session-token" }), "utf8");

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/GetCurrentPeriodUsage")) {
        return new Response(JSON.stringify(fixtureUsage()), { status: 200 });
      }
      if (url.endsWith("/GetPlanInfo")) {
        return new Response(JSON.stringify({ planInfo: { planName: "Pro", price: "$20/mo", includedAmountCents: 2000 } }), {
          status: 200,
        });
      }
      if (url.endsWith("/GetUsageLimitStatusAndActiveGrants")) {
        return new Response(JSON.stringify({ usageLimitPolicyStatus: { canAdjustOnDemand: true } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const rows = await collectCursorQuotaStatus({
      providerId: "provider-cursor",
      checkedAt,
      appDataRoot: root,
      fetchImpl,
    });
    expect(rows.some((row) => row.quotaKey === "window:cursor-models" && row.status === "ok")).toBe(true);
    expect(rows.some((row) => row.quotaKey === "window:other-models" && row.status === "ok")).toBe(true);
    expect(rows.every((row) => row.source === "cursor_internal_api")).toBe(true);
  });
});

describe("existing openai/deepseek quota mapping remains unchanged", () => {
  it("still maps OpenAI windows and DeepSeek-style billing", () => {
    const rows = mapUsageSnapshot({
      providerKey: "openai",
      providerId: "provider-openai",
      checkedAt,
      source: "provider_api",
      snapshot: {
        provider: "openai",
        displayName: "OpenAI",
        windows: [{ label: "5 hour", usedPercent: 25, resetAt: Date.parse("2026-08-22T17:00:00Z") }],
        billing: [{ type: "balance", label: "credits", amount: 12.5, unit: "USD" }],
      },
    });
    expect(rows.find((row) => row.quotaKey.startsWith("window"))?.remaining).toBe(75);
    expect(unsupportedQuotaRow("example", "provider-example", checkedAt).status).toBe("unsupported");
    expect(errorQuotaRow("deepseek", "provider-deepseek", checkedAt, new Error("Authorization: Bearer leak-token")).other).toEqual(
      sanitizeEventData({ error: "Authorization: Bearer leak-token" }, 4_096).value,
    );
  });
});
