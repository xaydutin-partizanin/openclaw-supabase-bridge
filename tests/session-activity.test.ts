import { describe, expect, it } from "vitest";
import { sessionEntryHasActiveRun } from "../src/session-activity.js";

describe("sessionEntryHasActiveRun", () => {
  it("treats running as active", () => {
    expect(sessionEntryHasActiveRun({ status: "running" })).toBe(true);
  });

  it("ignores recovery markers on terminal sessions", () => {
    expect(sessionEntryHasActiveRun({
      status: "done",
      restartRecoveryDeliveryRunId: "run-1",
    })).toBe(false);
  });

  it("keeps recovery markers active when status is missing/non-terminal", () => {
    expect(sessionEntryHasActiveRun({
      restartRecoveryDeliveryRunId: "run-1",
    })).toBe(true);
    expect(sessionEntryHasActiveRun({
      status: "starting",
      restartRecoveryDeliveryRunId: "run-1",
    })).toBe(true);
  });
});
