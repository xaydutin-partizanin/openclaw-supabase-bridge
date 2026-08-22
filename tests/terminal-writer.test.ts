import { describe, expect, it, vi } from "vitest";
import { TerminalWriter } from "../src/terminal-writer.js";
import type { TerminalWriteInput } from "../src/types.js";

function terminal(status: TerminalWriteInput["status"]): TerminalWriteInput {
  return {
    taskId: "task-1",
    runId: "run-1",
    status,
    reportText: status === "completed" ? "Done" : "Failed safely",
    report: { summary: status },
    error: status === "completed" ? null : "test failure",
    metadata: {},
    openclawRunId: "oc-run-1",
    openclawTaskId: null,
    actualProviderKey: "openai",
    actualModel: "gpt-5.6-sol",
  };
}

describe("terminal state writer", () => {
  it("writes one report only when completion is signaled twice", async () => {
    const writeTerminal = vi.fn(async () => true);
    const writer = new TerminalWriter({ writeTerminal });
    await expect(writer.write(terminal("completed"))).resolves.toBe(true);
    await expect(writer.write(terminal("completed"))).resolves.toBe(false);
    expect(writeTerminal).toHaveBeenCalledTimes(1);
  });

  it("captures failure status and error", async () => {
    const writeTerminal = vi.fn(async () => true);
    const writer = new TerminalWriter({ writeTerminal });
    await writer.write(terminal("failed"));
    expect(writeTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "test failure" }));
  });

  it("allows a retry after a database write failure", async () => {
    const writeTerminal = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true);
    const writer = new TerminalWriter({ writeTerminal });
    await expect(writer.write(terminal("completed"))).rejects.toThrow("offline");
    await expect(writer.write(terminal("completed"))).resolves.toBe(true);
  });
});
