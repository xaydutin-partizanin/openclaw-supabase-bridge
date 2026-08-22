import { Buffer } from "node:buffer";
import { toJson } from "./object-utils.js";
import type { Json } from "./types.js";

const SECRET_KEY = /(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie|set[-_]?cookie|credential|private[-_]?key|client[-_]?secret|environment|process[-_]?env|^env$)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_TOKEN = /\b(?:sk|sb_secret|service_role)[-_][A-Za-z0-9._~+/=-]{8,}/gi;
const URL_SECRET = /([?&](?:token|key|secret|password|authorization)=)[^&#\s]+/gi;

export interface SanitizedPayload {
  value: Record<string, Json>;
  truncated: boolean;
  originalSize: number;
}

function redactString(value: string): string {
  return value
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(SECRET_TOKEN, "[REDACTED]")
    .replace(URL_SECRET, "$1[REDACTED]");
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): Json {
  if (value === null || typeof value === "boolean" || typeof value === "number") return toJson(value);
  if (typeof value === "string") return redactString(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { redacted: "binary", byteLength: value.byteLength };
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, seen));
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        result[key] = "[REDACTED]";
      } else if (child !== undefined) {
        result[key] = sanitizeValue(child, seen);
      }
    }
    return result;
  }
  return String(value);
}

function trimStrings(value: Json, maxStringLength: number): Json {
  if (typeof value === "string") {
    if (value.length <= maxStringLength) return value;
    return `${value.slice(0, maxStringLength)}…[truncated]`;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => trimStrings(entry, maxStringLength));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, child]) => [key, trimStrings(child, maxStringLength)]),
    );
  }
  return value;
}

export function sanitizeEventData(data: unknown, maxPayloadBytes: number): SanitizedPayload {
  const sanitized = sanitizeValue(data, new WeakSet());
  const objectValue =
    sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? sanitized
      : { value: sanitized };
  const serialized = JSON.stringify(objectValue);
  const originalSize = Buffer.byteLength(serialized, "utf8");
  if (originalSize <= maxPayloadBytes) {
    return { value: objectValue, truncated: false, originalSize };
  }

  const compact = trimStrings(objectValue, Math.max(128, Math.floor(maxPayloadBytes / 8)));
  const compactSerialized = JSON.stringify(compact);
  const bounded = Buffer.byteLength(compactSerialized, "utf8") <= maxPayloadBytes
    ? compact
    : { preview: compactSerialized.slice(0, Math.max(128, maxPayloadBytes - 256)) };

  return {
    value: {
      truncated: true,
      original_size: originalSize,
      data: bounded,
    },
    truncated: true,
    originalSize,
  };
}
