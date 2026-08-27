import { describe, expect, it, vi } from "vitest";
import { listUnauthorizedReplacementChildren } from "../src/child-sessions.js";
import { tearDownSessionLineage } from "../src/session-lineage-teardown.js";

describe("listUnauthorizedReplacementChildren", () => {
  it("returns only children outside the authorized first-wave set", () => {
    const api = {
      runtime: {
        agent: {
          session: {
            listSessionEntries: vi.fn(() => [
              {
                sessionKey: "agent:cursor:acp:authorized",
                entry: {
                  sessionId: "a",
                  status: "done",
                  parentSessionKey: "agent:cursor:supabase-bridge:parent",
                },
              },
              {
                sessionKey: "agent:cursor:acp:replacement",
                entry: {
                  sessionId: "b",
                  status: "running",
                  parentSessionKey: "agent:cursor:supabase-bridge:parent",
                },
              },
            ]),
          },
        },
      },
    };
    const cfg = {
      agents: {
        list: [{ id: "cursor", workspace: "F:/tmp", runtime: { type: "acp" } }],
      },
    };

    const unauthorized = listUnauthorizedReplacementChildren(
      api as never,
      cfg as never,
      "agent:cursor:supabase-bridge:parent",
      new Set(["agent:cursor:acp:authorized"]),
    );
    expect(unauthorized.map((child) => child.sessionKey)).toEqual([
      "agent:cursor:acp:replacement",
    ]);
  });
});

describe("tearDownSessionLineage", () => {
  it("deletes ACP children before parent sessions", async () => {
    const order: string[] = [];
    const api = {
      runtime: {
        subagent: {
          deleteSession: vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
            order.push(sessionKey);
          }),
        },
      },
    };

    const result = await tearDownSessionLineage(api as never, [
      "agent:cursor:supabase-bridge:parent",
      "agent:cursor:acp:child",
    ]);

    expect(order).toEqual([
      "agent:cursor:acp:child",
      "agent:cursor:supabase-bridge:parent",
    ]);
    expect(result.deleted).toEqual(order);
    expect(result.failed).toEqual([]);
  });

  it("records failures when deleteSession is unavailable", async () => {
    const result = await tearDownSessionLineage(
      { runtime: {} } as never,
      ["agent:cursor:supabase-bridge:parent"],
    );
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([
      {
        sessionKey: "agent:cursor:supabase-bridge:parent",
        error: "runtime.subagent.deleteSession is unavailable",
      },
    ]);
  });
});
