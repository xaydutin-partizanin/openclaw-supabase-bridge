import { describe, expect, it, vi } from "vitest";
import { listActiveChildSessions, listChildSessions } from "../src/child-sessions.js";

describe("listChildSessions", () => {
  it("returns descendants by parentSessionKey or spawnedBy", () => {
    const api = {
      runtime: {
        agent: {
          session: {
            listSessionEntries: vi.fn(({ agentId }: { agentId: string }) => {
              if (agentId !== "cursor") return [];
              return [
                {
                  sessionKey: "agent:cursor:supabase-bridge:parent",
                  entry: { sessionId: "parent-id", status: "done" },
                },
                {
                  sessionKey: "agent:cursor:acp:child-a",
                  entry: {
                    sessionId: "child-a",
                    status: "running",
                    parentSessionKey: "agent:cursor:supabase-bridge:parent",
                  },
                },
                {
                  sessionKey: "agent:cursor:acp:child-b",
                  entry: {
                    sessionId: "child-b",
                    status: "done",
                    spawnedBy: "agent:cursor:supabase-bridge:parent",
                  },
                },
                {
                  sessionKey: "agent:cursor:acp:other",
                  entry: {
                    sessionId: "other",
                    status: "running",
                    parentSessionKey: "agent:cursor:other-parent",
                  },
                },
              ];
            }),
          },
        },
      },
    };
    const cfg = {
      agents: {
        list: [{ id: "cursor", workspace: "F:/tmp", runtime: { type: "acp" } }],
      },
    };

    const children = listChildSessions(api as never, cfg as never, "agent:cursor:supabase-bridge:parent");
    expect(children.map((child) => child.sessionKey).sort()).toEqual([
      "agent:cursor:acp:child-a",
      "agent:cursor:acp:child-b",
    ]);
    expect(listActiveChildSessions(api as never, cfg as never, "agent:cursor:supabase-bridge:parent")).toEqual([
      expect.objectContaining({ sessionKey: "agent:cursor:acp:child-a", hasActiveRun: true }),
    ]);
  });
});
