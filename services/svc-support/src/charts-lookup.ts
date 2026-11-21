import {
  serviceCallSigner,
  SUPPORT_CHARTS_ALERTS_PROCEDURE,
  supportChartsAlertsReadSchema,
  supportDeskLayoutsPath,
  supportDeskLayoutsReadSchema,
  unwrapTrpcData,
  type ServiceAuthMode,
  type ServiceSigner,
  type SupportChartsAlertsRead,
  type SupportDeskLayoutsRead,
} from '@intafaced/contracts';
import { identitySecretSet } from './identity-grounding-honesty.js';

/**
 * A CUSTOMER'S ALERTS AND LAYOUTS, READ FROM THE SERVICES THAT OWN THEM (C-ops-03 (a), J-charts-desk-19 #1).
 *
 * svc-notify owns price alerts and their trigger log; svc-identity owns the saved desk layouts (`trade.desk.layouts`).
 * svc-support keeps no copy: each lookup reads both, per request, on svc-support's own service credential, for the
 * customer named by the ticket. Each door admits svc-support alone and is read-only.
 *
 * A source that cannot answer says which way: `unwired` (no address or credential set) or `plane_dark` (it did not
 * answer, or answered with a shape not its contract, or about another account). Never an empty list in their place.
 */
export type SourceRead<T> =
  { readonly status: 'read'; readonly data: T } | { readonly status: 'unread'; readonly reason: 'plane_dark' | 'unwired' };

export interface ChartsAlertsSource {
  alertsOf(userId: string): Promise<SourceRead<SupportChartsAlertsRead>>;
}
export interface DeskLayoutsSource {
  layoutsOf(userId: string): Promise<SourceRead<SupportDeskLayoutsRead>>;
}

const UNWIRED = { status: 'unread', reason: 'unwired' } as const;
const DARK = { status: 'unread', reason: 'plane_dark' } as const;

export const UNWIRED_CHARTS_SOURCES: { readonly alerts: ChartsAlertsSource; readonly layouts: DeskLayoutsSource } = {
  alerts: { alertsOf: async () => UNWIRED },
  layouts: { layoutsOf: async () => UNWIRED },
};

type S2s = { signer: ServiceSigner; mode: ServiceAuthMode };

function baseOf(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function bounded<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** svc-notify's `supportCharts.alerts`, on svc-support's pairwise secret for notify (or its per-service key). */
export function createNotifyChartsClient(options: {
  notifyUrl?: string;
  secret?: string;
  s2s?: S2s;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): ChartsAlertsSource {
  const base = baseOf(options.notifyUrl);
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  if (base === null || !credentialed) return UNWIRED_CHARTS_SOURCES.alerts;
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-notify', legacySecret: options.secret ?? '', s2s: options.s2s });
  return {
    async alertsOf(userId) {
      const body = JSON.stringify({ userId });
      const target = `${base}/trpc/${SUPPORT_CHARTS_ALERTS_PROCEDURE}`;
      return bounded<SourceRead<SupportChartsAlertsRead>>(
        options.timeoutMs ?? 10_000,
        async (signal) => {
          const response = await (options.fetcher ?? fetch)(target, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              'content-type': 'application/json',
              ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
            },
            body,
          });
          if (!response.ok) return DARK;
          const parsed = supportChartsAlertsReadSchema.safeParse(unwrapTrpcData(await response.json()));
          // Bound to the account asked about: an answer about anyone else is not this customer's alerts.
          if (!parsed.success || parsed.data.userId.toLowerCase() !== userId.toLowerCase()) return DARK;
          return { status: 'read', data: parsed.data };
        },
        DARK,
      );
    },
  };
}

/** svc-identity's `GET /internal/desk-layouts/:userId`, on the internal secret (or svc-support's per-service key). */
export function createIdentityLayoutsClient(options: {
  identityUrl?: string;
  secret?: string;
  s2s?: S2s;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): DeskLayoutsSource {
  const base = baseOf(options.identityUrl);
  if (base === null || !identitySecretSet(options.secret)) return UNWIRED_CHARTS_SOURCES.layouts;
  const sign = serviceCallSigner({
    service: 'svc-support',
    audience: 'svc-identity',
    legacySecret: options.secret ?? '',
    s2s: options.s2s,
  });
  return {
    async layoutsOf(userId) {
      const target = `${base}${supportDeskLayoutsPath(userId)}`;
      return bounded<SourceRead<SupportDeskLayoutsRead>>(
        options.timeoutMs ?? 10_000,
        async (signal) => {
          const response = await (options.fetcher ?? fetch)(target, {
            method: 'GET',
            redirect: 'error',
            signal,
            headers: {
              'content-type': 'application/json',
              ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
            },
          });
          if (!response.ok) return DARK;
          const parsed = supportDeskLayoutsReadSchema.safeParse(await response.json());
          if (!parsed.success || parsed.data.userId.toLowerCase() !== userId.toLowerCase()) return DARK;
          return { status: 'read', data: parsed.data };
        },
        DARK,
      );
    },
  };
}
