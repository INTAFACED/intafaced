/**
 * Before a key carrying `copy:lead` is minted, svc-identity asks svc-trade whether the account is an approved lead
 * (J-copy-bots-otc-07 #1 #2): trade owns the listing, so identity never reads it. Timeout 3 seconds, one retry.
 * Anything other than a well-formed 2xx is `unavailable`, which the mint refuses, never treats as "a lead".
 */
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

const TIMEOUT_MS = 3_000;
const ATTEMPTS = 2;

export type LeadCheck = (userId: string) => Promise<'lead' | 'not_lead' | 'unavailable'>;

export type LeadCheckFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export function parseLeadCheckResponse(status: number, raw: string): 'lead' | 'not_lead' | 'unavailable' {
  if (status < 200 || status >= 300) return 'unavailable';
  try {
    const body = JSON.parse(raw) as { lead?: unknown; asOf?: unknown } | null;
    if (!body || typeof body.asOf !== 'string' || typeof body.lead !== 'boolean') return 'unavailable';
    return body.lead ? 'lead' : 'not_lead';
  } catch {
    return 'unavailable';
  }
}

async function defaultFetch(url: string, init: Parameters<LeadCheckFetch>[1]) {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
}

/** `url` is svc-trade's base URL. Blank: every check is unavailable, so a `copy:lead` key refuses. */
export function httpLeadCheck(options: {
  url: string | undefined;
  secret: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetchImpl?: LeadCheckFetch;
  timeoutMs?: number;
}): LeadCheck {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  return async (userId) => {
    const url = options.url?.trim();
    if (!url || !options.secret) return 'unavailable';
    const body = JSON.stringify({ userId });
    const target = `${url.replace(/\/$/, '')}/internal/copy/lead-check`;
    const sign = serviceCallSigner({ service: 'svc-identity', audience: 'svc-trade', legacySecret: options.secret, s2s: options.s2s });
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        // A key signature carries a nonce, so each attempt is signed afresh.
        const headers = {
          'content-type': 'application/json',
          ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
        };
        const response = await fetchImpl(target, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        const answer = parseLeadCheckResponse(response.status, await response.text());
        if (answer !== 'unavailable') return answer;
      } catch {
        // Retry once; the reason stays off the log.
      }
    }
    return 'unavailable';
  };
}
