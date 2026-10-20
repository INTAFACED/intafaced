/**
 * Live pay metrics from svc-pay S2S (`GET /internal/agents/merchant-watch-metrics`).
 *
 * Unset PAY_URL = honest `no_live_metrics`. Empty or 503 body = same refuse.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { ApprovalRatePoint } from './watch.js';
import type { PayMetricsPort } from './pay-metrics-port.js';

export const PAY_MERCHANT_WATCH_METRICS_PATH = '/internal/agents/merchant-watch-metrics' as const;

export type HttpPayMetricsOptions = {
  readonly payUrl: string;
  readonly internalSecret: string;
  /** svc-agents' own key. With it the call is key-signed for svc-pay; `dual` also sends the shared-secret form. */
  readonly s2s?: { readonly signer: ServiceSigner; readonly mode: ServiceAuthMode };
  readonly fetchImpl?: typeof fetch;
};

type MetricsBody = { readonly ok: true; readonly points: readonly ApprovalRatePoint[] } | { readonly ok: false; readonly reason: string };

function parsePoints(raw: unknown): readonly ApprovalRatePoint[] {
  if (raw === null || typeof raw !== 'object') return [];
  const body = raw as MetricsBody;
  if (body.ok !== true || !Array.isArray(body.points)) return [];
  return body.points;
}

/**
 * Live samples from pay internal route. Non-200, refuse body, or empty points → [].
 */
export function createHttpPayMetricsPort(options: HttpPayMetricsOptions): PayMetricsPort {
  const payUrl = options.payUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sign = serviceCallSigner({
    service: 'svc-agents',
    audience: 'svc-pay',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });

  return {
    async sample() {
      let response: Response;
      try {
        const target = `${payUrl}${PAY_MERCHANT_WATCH_METRICS_PATH}`;
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
      return parsePoints(body);
    },
  };
}
