import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const state = vi.hoisted(() => ({ created: 0, stops: 0 }));

vi.mock("../src/controller.js", () => ({
  BridgeController: class {
    started = true;
    constructor() { state.created += 1; }
    async start() {}
    async stop() { state.stops += 1; this.started = false; }
    async handleAgentEvent() {}
    async handleHook() {}
    async recordOutbound() { return "mock"; }
  },
}));

vi.mock("../src/config.js", () => ({ resolvePluginConfig: () => ({}) }));

import { bridgeRuntimeSnapshot, configureBridgeRuntime, startBridgeAccount, stopAllBridgeAccounts } from "../src/runtime-registry.js";

describe("single bridge runtime owner", () => {
  it("replaces, rather than duplicates, a controller for the same account", async () => {
    state.created = 0;
    state.stops = 0;
    configureBridgeRuntime({ logger: {} } as OpenClawPluginApi);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = startBridgeAccount({ accountId: "default", cfg: {}, abortSignal: firstAbort.signal });
    await Promise.resolve();
    expect(bridgeRuntimeSnapshot()).toMatchObject({ accountIds: ["default"], controllerCount: 1, eventOwnerCount: 1 });
    const second = startBridgeAccount({ accountId: "default", cfg: {}, abortSignal: secondAbort.signal });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.created).toBe(2);
    expect(state.stops).toBeGreaterThanOrEqual(1);
    expect(bridgeRuntimeSnapshot().controllerCount).toBe(1);
    firstAbort.abort();
    secondAbort.abort();
    await Promise.all([first, second]);
    await stopAllBridgeAccounts();
    expect(bridgeRuntimeSnapshot().controllerCount).toBe(0);
  });
});
