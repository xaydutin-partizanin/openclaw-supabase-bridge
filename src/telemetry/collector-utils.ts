import { createHash } from "node:crypto";
import { asRecord, asString, toJson } from "../object-utils.js";
import { sanitizeEventData } from "../sanitizer.js";
import type { Json, TelemetryRow, TelemetryWrite } from "../types.js";
import { freshnessFields } from "./freshness.js";

export function stableKey(...parts: Array<string | number | null | undefined>): string {
  return parts.map((part) => String(part ?? "").trim().toLowerCase()).join(":");
}

export function stableHash(...parts: Array<string | number | null | undefined>): string {
  return createHash("sha256").update(stableKey(...parts)).digest("hex");
}

export function rows(value: unknown, key: string): Record<string, unknown>[] {
  const root = asRecord(value);
  const candidate = root[key];
  return Array.isArray(candidate) ? candidate.map(asRecord) : [];
}

export function safeMetadata(value: unknown, maxBytes = 16_384): Record<string, Json> {
  return sanitizeEventData(value, maxBytes).value;
}

export function observedRow(input: {
  row: TelemetryRow;
  observedAt: string;
  staleAfterMs: number;
  bootId: string;
}): TelemetryRow {
  return {
    ...input.row,
    ...freshnessFields(input),
  };
}

export function write(table: string, onConflict: string, mappedRows: TelemetryRow[]): TelemetryWrite {
  return { table, onConflict, rows: mappedRows };
}

export function nullableString(value: unknown): string | null {
  return asString(value) ?? null;
}

export function json(value: unknown): Json {
  return toJson(value);
}
