import { describe, expect, it } from "vitest";
import { resolveTargetedExecutionConfig } from "../src/config-resolution.js";
import { configs } from "./fixtures.js";

describe("target-aware configuration selection", () => {
  it("selects an available target-agent config when none was requested", () => {
    expect(resolveTargetedExecutionConfig(null, "cursor", configs()).config.configKey).toBe("cursor:acp:cursor:auto");
  });

  it("preserves an explicit exact configuration", () => {
    const result = resolveTargetedExecutionConfig("cursor:acp:cursor:auto", "cursor", configs());
    expect(result.fallbackUsed).toBe(false);
  });

  it("does not silently fall back for an explicit targeted config", () => {
    expect(() => resolveTargetedExecutionConfig("missing", "cursor", configs())).toThrow(/not available/);
  });

  it("does not route a target to a config owned by another agent", () => {
    expect(() => resolveTargetedExecutionConfig("main:native:openai:gpt-5-6-sol:low", "cursor", configs())).toThrow(/belongs to agent/);
  });
});
