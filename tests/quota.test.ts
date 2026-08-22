import { describe, expect, it } from "vitest";
import { errorQuotaRow, mapUsageSnapshot, unsupportedQuotaRow } from "../src/quota.js";

const checkedAt = "2026-08-22T12:00:00.000Z";

describe("quota mapping", () => {
  it("maps provider windows and multiple billing buckets honestly", () => {
    const rows = mapUsageSnapshot({
      providerKey: "openai",
      providerId: "provider-openai",
      checkedAt,
      source: "provider_api",
      snapshot: {
        provider: "openai",
        displayName: "OpenAI",
        windows: [{ label: "5 hour", usedPercent: 25, resetAt: Date.parse("2026-08-22T17:00:00Z") }],
        billing: [
          { type: "balance", label: "credits", amount: 12.5, unit: "USD" },
          { type: "budget", label: "monthly", used: 4, limit: 10, unit: "USD", period: "month" },
        ],
      },
    });
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.quotaKey.startsWith("window"))?.remaining).toBe(75);
    expect(rows.find((row) => row.quotaKey.startsWith("balance"))?.remaining).toBe(12.5);
    expect(rows.find((row) => row.quotaKey.startsWith("budget"))?.remaining).toBe(6);
  });

  it("records an empty successful response as unknown, not zero", () => {
    const [row] = mapUsageSnapshot({
      providerKey: "example",
      providerId: "provider-example",
      checkedAt,
      source: "provider_api",
      snapshot: { provider: "example", displayName: "Example", windows: [] },
    });
    expect(row?.status).toBe("unknown");
    expect(row?.remaining).toBeNull();
  });

  it("represents unsupported providers and provider API errors without guesses", () => {
    expect(unsupportedQuotaRow("cursor", "provider-cursor", checkedAt)).toMatchObject({
      status: "unsupported",
      remaining: null,
      source: "unavailable",
    });
    const error = errorQuotaRow("deepseek", "provider-deepseek", checkedAt, new Error("provider unavailable"));
    expect(error.status).toBe("error");
    expect(error.remaining).toBeNull();
  });
});
