import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { errorMessage } from "./object-utils.js";

export interface SessionTeardownResult {
  deleted: string[];
  failed: Array<{ sessionKey: string; error: string }>;
}

type DeleteSession = (params: {
  sessionKey: string;
  deleteTranscript?: boolean;
}) => Promise<unknown>;

function resolveDeleteSession(api: OpenClawPluginApi): DeleteSession | null {
  const deleteSession = (api.runtime as { subagent?: { deleteSession?: DeleteSession } }).subagent?.deleteSession;
  return typeof deleteSession === "function" ? deleteSession.bind(api.runtime.subagent) : null;
}

/**
 * Tear down a bridge-owned OpenClaw session lineage so yield/announce cannot
 * silently resume the parent and spawn replacement ACP children after the
 * bridge task has terminalized.
 */
export async function tearDownSessionLineage(
  api: OpenClawPluginApi,
  sessionKeys: readonly string[],
  options?: { deleteTranscript?: boolean },
): Promise<SessionTeardownResult> {
  const deleteSession = resolveDeleteSession(api);
  const deleted: string[] = [];
  const failed: Array<{ sessionKey: string; error: string }> = [];
  const unique = [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))];
  if (!deleteSession) {
    for (const sessionKey of unique) {
      failed.push({ sessionKey, error: "runtime.subagent.deleteSession is unavailable" });
    }
    return { deleted, failed };
  }

  // Children first, then parents — avoid parent announce racing a live child delete.
  const ordered = [...unique].sort((a, b) => {
    const aChild = a.includes(":acp:") ? 0 : 1;
    const bChild = b.includes(":acp:") ? 0 : 1;
    return aChild - bChild;
  });

  for (const sessionKey of ordered) {
    try {
      await deleteSession({
        sessionKey,
        deleteTranscript: options?.deleteTranscript ?? false,
      });
      deleted.push(sessionKey);
    } catch (error) {
      failed.push({ sessionKey, error: errorMessage(error) });
    }
  }
  return { deleted, failed };
}
