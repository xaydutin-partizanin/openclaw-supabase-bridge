import { describe, expect, it, vi } from "vitest";
import { LifecycleResources } from "../src/lifecycle-resources.js";

describe("bridge shutdown", () => {
  it("removes listeners and timers once across repeated stop calls", async () => {
    const resources = new LifecycleResources();
    const removeSupabaseListener = vi.fn();
    const removeAgentListener = vi.fn();
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const timer = setTimeout(() => undefined, 60_000);
    resources.add(removeSupabaseListener);
    resources.add(removeAgentListener);
    resources.addTimer(timer);
    await resources.stop();
    await resources.stop();
    expect(removeSupabaseListener).toHaveBeenCalledTimes(1);
    expect(removeAgentListener).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledWith(timer);
    clearTimer.mockRestore();
  });
});
