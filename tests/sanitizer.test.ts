import { describe, expect, it } from "vitest";
import { sanitizeEventData } from "../src/sanitizer.js";

describe("event sanitizer", () => {
  it("redacts credential fields and bearer values", () => {
    const result = sanitizeEventData({
      Authorization: "Bearer abcdefghijklmnop",
      nested: { api_key: "secret-value", password: "hunter2" },
      text: "call with Bearer zyxwvutsrqponmlk",
    }, 10_000);
    expect(JSON.stringify(result.value)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(result.value)).not.toContain("secret-value");
    expect(JSON.stringify(result.value)).not.toContain("hunter2");
  });

  it("truncates giant payloads and records original size", () => {
    const result = sanitizeEventData({ stdout: "x".repeat(50_000) }, 1_024);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBeGreaterThan(1_024);
    expect(result.value.truncated).toBe(true);
  });

  it("preserves useful command and file information", () => {
    const result = sanitizeEventData({ command: "npm test", file: "src/index.ts", exitCode: 0 }, 10_000);
    expect(result.value).toMatchObject({ command: "npm test", file: "src/index.ts", exitCode: 0 });
  });
});
