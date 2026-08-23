import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export type CursorAuthSource = "user_api_key_exchange" | "cursor_auth_json" | "cursor_state_vscdb";

export type CursorAccessTokenResult =
  | { ok: true; accessToken: string; source: CursorAuthSource }
  | { ok: false; reason: string; detail?: string };

const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

function cursorAppDataRoot(override?: string): string {
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) return path.join(appData, "Cursor");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor");
  }
  return path.join(os.homedir(), ".config", "Cursor");
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Read session access token from Cursor's auth.json (preferred local source). */
export function readAccessTokenFromAuthJson(appDataRoot?: string): string | null {
  const filePath = path.join(cursorAppDataRoot(appDataRoot), "auth.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!data || typeof data !== "object") return null;
    return asNonEmptyString((data as Record<string, unknown>).accessToken);
  } catch {
    return null;
  }
}

/**
 * Read session access token from Cursor state.vscdb (read-only via node:sqlite).
 * Never throws credential material; returns null on failure.
 */
export function readAccessTokenFromStateDb(appDataRoot?: string): string | null {
  const dbPath = path.join(cursorAppDataRoot(appDataRoot), "User", "globalStorage", "state.vscdb");
  if (!fs.existsSync(dbPath)) return null;
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        filename: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare: (sql: string) => { get: (...params: unknown[]) => { value?: unknown } | undefined };
        close: () => void;
      };
    };
    // Open read-only via URI so we do not mutate Cursor's DB.
    const db = new DatabaseSync(`file:${dbPath.replace(/\\/g, "/")}?mode=ro`, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
      const value = row?.value;
      if (typeof value === "string") return asNonEmptyString(value);
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return asNonEmptyString(Buffer.from(value).toString("utf8"));
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function exchangeUserApiKey(
  userApiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorAccessTokenResult> {
  try {
    // Cursor's undocumented exchange endpoint expects the User API Key
    // (typically `crsr_…`) as Authorization Bearer with an empty JSON object body.
    // Community CLI/SDK clients use this shape; a JSON `{ userApiKey }` body is not the accepted form.
    const response = await fetchImpl(EXCHANGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : `http_${response.status}`;
      const safe = message.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 200);
      return { ok: false, reason: "user_api_key_exchange_failed", detail: safe };
    }
    const token =
      body && typeof body === "object"
        ? asNonEmptyString((body as Record<string, unknown>).accessToken) ??
          asNonEmptyString((body as Record<string, unknown>).token)
        : null;
    if (!token) {
      return { ok: false, reason: "user_api_key_exchange_missing_token" };
    }
    return { ok: true, accessToken: token, source: "user_api_key_exchange" };
  } catch (error) {
    return {
      ok: false,
      reason: "user_api_key_exchange_error",
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown_error",
    };
  }
}

/**
 * Resolve a Cursor access token for DashboardService RPCs.
 * Preference: User API Key exchange → auth.json → state.vscdb.
 */
export async function resolveCursorAccessToken(input: {
  userApiKey?: string | null;
  appDataRoot?: string;
  fetchImpl?: typeof fetch;
}): Promise<CursorAccessTokenResult> {
  const key = asNonEmptyString(input.userApiKey);
  if (key) {
    const exchanged = await exchangeUserApiKey(key, input.fetchImpl ?? fetch);
    if (exchanged.ok) return exchanged;
  }

  const fromAuthJson = readAccessTokenFromAuthJson(input.appDataRoot);
  if (fromAuthJson) {
    return { ok: true, accessToken: fromAuthJson, source: "cursor_auth_json" };
  }

  const fromDb = readAccessTokenFromStateDb(input.appDataRoot);
  if (fromDb) {
    return { ok: true, accessToken: fromDb, source: "cursor_state_vscdb" };
  }

  if (key) {
    return { ok: false, reason: "user_api_key_exchange_failed_and_no_local_session" };
  }
  return { ok: false, reason: "cursor_auth_unavailable" };
}
