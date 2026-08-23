import { describe, expect, it } from "vitest";
import { capabilityCollectors } from "../src/telemetry/collectors/capabilities.js";
import { coreCollectors } from "../src/telemetry/collectors/core.js";
import { operationCollectors } from "../src/telemetry/collectors/operations.js";
import { adaptiveStaleAfterMs, freshnessAt, freshnessFields } from "../src/telemetry/freshness.js";

describe("telemetry freshness", () => {
  it("transitions from fresh to stale at the explicit deadline", () => {
    const fields = freshnessFields({ observedAt: "2026-08-22T12:00:00.000Z", ingestedAt: "2026-08-22T12:00:01.000Z", staleAfterMs: 60_000, bootId: "boot-a" });
    expect(freshnessAt(new Date("2026-08-22T12:00:59.000Z"), fields.stale_after as string)).toBe("fresh");
    expect(freshnessAt(new Date("2026-08-22T12:01:00.000Z"), fields.stale_after as string)).toBe("stale");
    expect(fields.boot_id).toBe("boot-a");
  });

  it("keeps explicit error and missing deadlines from appearing healthy", () => {
    expect(freshnessAt(new Date(), null)).toBe("stale");
    expect(freshnessAt(new Date(), "2099-01-01T00:00:00.000Z", true)).toBe("error");
  });

  it("keeps every collector row deadline beyond its maximum adaptive poll interval", () => {
    expect(adaptiveStaleAfterMs(2 * 60_000, 15 * 60_000)).toBe(20 * 60_000);
    for (const collector of [...coreCollectors, ...capabilityCollectors, ...operationCollectors]) {
      expect(collector.staleAfterMs, collector.id).toBeGreaterThan(collector.maxIntervalMs ?? collector.intervalMs);
    }
  });
});
