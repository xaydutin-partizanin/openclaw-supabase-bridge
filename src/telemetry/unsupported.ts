import { observedRow, stableKey, write } from "./collector-utils.js";
import type { CollectorContext, CollectorResult } from "./types.js";

export function unsupportedCollectorResult(input: {
  context: CollectorContext;
  domain: string;
  reason: string;
  staleAfterMs: number;
}): CollectorResult {
  const observedAt = input.context.now.toISOString();
  const row = {
    ...observedRow({
      row: {
        document_key: stableKey(input.context.instanceKey, "unsupported", input.domain),
        instance_key: input.context.instanceKey,
        domain: input.domain,
        authority: "unsupported_by_openclaw_external_plugin_api",
        supported: false,
        document: {
          reason: input.reason,
          openclaw_version: input.context.api.runtime.version,
          restriction: "external_plugin_gateway_requests_require_bundled_or_trusted_official_provenance",
        },
      },
      observedAt,
      staleAfterMs: input.staleAfterMs,
      bootId: input.context.bootId,
    }),
    freshness: "unsupported",
  };
  return {
    authority: "unsupported_by_openclaw_external_plugin_api",
    observedAt,
    freshness: "unsupported",
    unsupportedReason: input.reason,
    writes: [write("state_documents", "document_key", [row])],
  };
}
