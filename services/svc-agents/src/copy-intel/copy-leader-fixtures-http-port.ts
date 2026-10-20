/**
 * Live leader fixtures from svc-trade S2S (`GET /internal/agents/copy-leader-fixtures`).
 *
 * Unset TRADE_URL = honest `no_live_leaders`. Empty or 503 body = same refuse.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { CopyLeaderFixturesPort } from './live-leader-fixtures-port.js';
import type { LeaderPerformanceFixture } from './stats.js';

export const TRADE_COPY_LEADER_FIXTURES_PATH = '/internal/agents/copy-leader-fixtures' as const;

export type HttpCopyLeaderFixturesOptions = {
  readonly tradeUrl: string;
  readonly internalSecret: string;
  /** svc-agents' own key. With it the call is key-signed for svc-trade; `dual` also sends the shared-secret form. */
  readonly s2s?: { readonly signer: ServiceSigner; readonly mode: ServiceAuthMode };
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
  const sign = serviceCallSigner({
    service: 'svc-agents',
    audience: 'svc-trade',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });

  return {
    async sample() {
      let response: Response;
      try {
        const target = `${tradeUrl}${TRADE_COPY_LEADER_FIXTURES_PATH}`;
        response = await fetchImpl(target, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: '' }),
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
