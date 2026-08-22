import { describe, expect, it } from "vitest";
import { claimTaskInMemory } from "../src/claim-policy.js";
import { NOW, task } from "./fixtures.js";

describe("task claim policy", () => {
  it("allows the first worker and rejects a duplicate live claim", () => {
    const first = claimTaskInMemory(task(), "worker-a", NOW, 300);
    expect(first?.claimedBy).toBe("worker-a");
    expect(claimTaskInMemory(first!, "worker-b", new Date(NOW.getTime() + 1_000), 300)).toBeNull();
  });

  it("recovers an expired lease", () => {
    const expired = task({
      status: "claimed",
      claimedBy: "dead-worker",
      leaseExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
    });
    expect(claimTaskInMemory(expired, "worker-b", NOW, 300)?.claimedBy).toBe("worker-b");
  });

  it("never reclaims a completed task", () => {
    expect(claimTaskInMemory(task({ status: "completed" }), "worker-b", NOW, 300)).toBeNull();
  });
});
