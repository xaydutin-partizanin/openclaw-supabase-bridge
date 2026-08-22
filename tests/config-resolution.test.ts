import { describe, expect, it } from "vitest";
import { MissingDefaultConfigError, resolveExecutionConfig } from "../src/config-resolution.js";
import { configs } from "./fixtures.js";

describe("execution config resolution", () => {
  it("uses a valid requested configuration", () => {
    const result = resolveExecutionConfig("cursor:acp:cursor:auto", configs());
    expect(result.config.agent).toBe("cursor");
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackReason).toBeNull();
  });

  it("falls back when no config was requested", () => {
    const result = resolveExecutionConfig(null, configs());
    expect(result.config.isDefault).toBe(true);
    expect(result.fallbackReason).toBe("missing_requested_config");
  });

  it("falls back for an unknown config", () => {
    const result = resolveExecutionConfig("does-not-exist", configs());
    expect(result.config.isDefault).toBe(true);
    expect(result.fallbackReason).toBe("unknown_config");
  });

  it("falls back for an unavailable config", () => {
    const result = resolveExecutionConfig("main:native:deepseek:pro:default", configs());
    expect(result.config.isDefault).toBe(true);
    expect(result.fallbackReason).toBe("config_unavailable");
  });

  it("fails clearly when no available default exists", () => {
    const unavailable = configs().map((config) => ({ ...config, isDefault: false }));
    expect(() => resolveExecutionConfig(null, unavailable)).toThrow(MissingDefaultConfigError);
  });
});
