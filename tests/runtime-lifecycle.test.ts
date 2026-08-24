import { describe, expect, it, vi } from "vitest";

const stopAll = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/runtime-registry.js", () => ({
  stopAllBridgeAccounts: stopAll,
}));

import {
  cleanupBridgeRuntimeLifecycle,
  shouldStopBridgeOnHostCleanup,
} from "../src/runtime-lifecycle.js";

describe("bridge runtime lifecycle ownership", () => {
  it("stops the bridge only for host disable, not session reset/delete/restart", () => {
    expect(shouldStopBridgeOnHostCleanup("disable")).toBe(true);
    expect(shouldStopBridgeOnHostCleanup("reset")).toBe(false);
    expect(shouldStopBridgeOnHostCleanup("delete")).toBe(false);
    expect(shouldStopBridgeOnHostCleanup("restart")).toBe(false);
  });

  it("ignores session lifecycle cleanup and leaves controllers running", async () => {
    stopAll.mockClear();
    for (const reason of ["reset", "delete", "restart"] as const) {
      await expect(cleanupBridgeRuntimeLifecycle({ reason, sessionKey: "agent:main:one" })).resolves.toBe(
        "ignored",
      );
    }
    expect(stopAll).not.toHaveBeenCalled();
  });

  it("stops all bridge accounts on actual plugin/Gateway disable", async () => {
    stopAll.mockClear();
    await expect(cleanupBridgeRuntimeLifecycle({ reason: "disable" })).resolves.toBe("stopped");
    expect(stopAll).toHaveBeenCalledTimes(1);
  });
});
