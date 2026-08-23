import { resolveCursorAccessToken } from "./auth.js";
import { collectCursorQuotaObservation } from "./client.js";
import { cursorAuthUnavailableRow, mapCursorQuotaObservation } from "./map.js";
import type { QuotaStatus } from "../types.js";

export { resolveCursorAccessToken, readAccessTokenFromAuthJson, readAccessTokenFromStateDb, exchangeUserApiKey } from "./auth.js";
export { collectCursorQuotaObservation, fetchCurrentPeriodUsage, fetchPlanInfo } from "./client.js";
export { mapCursorQuotaObservation, cursorAuthUnavailableRow } from "./map.js";

export async function collectCursorQuotaStatus(input: {
  providerId: string;
  checkedAt: string;
  userApiKey?: string | null;
  appDataRoot?: string;
  fetchImpl?: typeof fetch;
}): Promise<QuotaStatus[]> {
  const authInput: {
    userApiKey?: string | null;
    appDataRoot?: string;
    fetchImpl?: typeof fetch;
  } = {};
  if (input.userApiKey !== undefined) authInput.userApiKey = input.userApiKey;
  if (input.appDataRoot !== undefined) authInput.appDataRoot = input.appDataRoot;
  if (input.fetchImpl !== undefined) authInput.fetchImpl = input.fetchImpl;

  const auth = await resolveCursorAccessToken(authInput);
  if (!auth.ok) {
    return [cursorAuthUnavailableRow(input.providerId, input.checkedAt, auth.reason)];
  }

  const observationInput: {
    accessToken: string;
    authSource: typeof auth.source;
    fetchImpl?: typeof fetch;
  } = {
    accessToken: auth.accessToken,
    authSource: auth.source,
  };
  if (input.fetchImpl !== undefined) observationInput.fetchImpl = input.fetchImpl;

  const observation = await collectCursorQuotaObservation(observationInput);
  if (!observation.ok) {
    return [
      cursorAuthUnavailableRow(
        input.providerId,
        input.checkedAt,
        observation.reason,
        auth.source,
        observation.detail,
      ),
    ];
  }

  return mapCursorQuotaObservation({
    observation: observation.data,
    providerId: input.providerId,
    checkedAt: input.checkedAt,
  });
}
