/**
 * Live leader fixtures from svc-trade S2S (`GET /internal/agents/copy-leader-fixtures`).
 *
 * Unset TRADE_URL = honest `no_live_leaders`. A non-200, a thrown fetch, or an
 * empty body returns no rows (`[]`).
 */

import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import type { CopyLeaderFixturesPort } from './live-leader-fixtures-port.js';
import type { LeaderPerformanceFixture } from './stats.js';

export const TRADE_COPY_LEADER_FIXTURES_PATH = '/internal/agents/copy-leader-fixtures' as const;

export type HttpCopyLeaderFixturesOptions = {
  readonly tradeUrl: string;
  readonly internalSecret: string;
  readonly fetchImpl?: typeof fetch;
};

type FixturesBody =
  { readonly ok: true; readonly fixtures: readonly LeaderPerformanceFixture[] } | { readonly ok: false; readonly reason: string };

function parseFixtures(raw: unknown): readonly LeaderPerformanceFixture[] {
  if (raw === null || typeof raw !== 'object') return [];
  const body = raw as FixturesBody;
  if (body.ok !== true || !Array.isArray(body.fixtures)) return [];
  return body.fixtures;
}

/**
 * Live samples from trade internal route. Non-200, refuse body, or empty fixtures → [].
 */
export function createHttpCopyLeaderFixturesPort(options: HttpCopyLeaderFixturesOptions): CopyLeaderFixturesPort {
  const tradeUrl = options.tradeUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async sample() {
      let response: Response;
      try {
        response = await fetchImpl(`${tradeUrl}${TRADE_COPY_LEADER_FIXTURES_PATH}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...serviceAuthHeadersForBody('svc-agents', options.internalSecret, ''),
          },
        });
      } catch {
        return [];
      }
      if (!response.ok) return [];
      const body = await response.json().catch(() => null);
      return parseFixtures(body);
    },
  };
}
