/**
 * Calls one owning service's closure check. Identity does not read balances.
 * Timeout is 3 seconds. One retry. Anything other than a well-formed 2xx is
 * unavailable, which the caller must not treat as "nothing is open".
 */
import { serviceAuthHeadersForBody } from '@intafaced/contracts';

const TIMEOUT_MS = 3_000;
const ATTEMPTS = 2;
const AMOUNT = /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export type ClosureBlocker = { readonly code: string; readonly count: number };
export type ClosureBalance = { readonly assetId: string; readonly amount: string };

export type ClosureCheckResult =
  | { readonly ok: true; readonly blockers: readonly ClosureBlocker[]; readonly balances: readonly ClosureBalance[] }
  | { readonly ok: false };

export type ClosureFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

function blocker(value: unknown): ClosureBlocker | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { code?: unknown; count?: unknown };
  if (typeof row.code !== 'string' || row.code.length < 1 || row.code.length > 64) return null;
  if (typeof row.count !== 'number' || !Number.isInteger(row.count) || row.count < 1) return null;
  return { code: row.code, count: row.count };
}

function balance(value: unknown): ClosureBalance | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { assetId?: unknown; amount?: unknown };
  if (typeof row.assetId !== 'string' || row.assetId.length < 1 || row.assetId.length > 32) return null;
  if (typeof row.amount !== 'string' || !AMOUNT.test(row.amount)) return null;
  return { assetId: row.assetId, amount: row.amount };
}

export function parseClosureCheckResponse(status: number, raw: string): ClosureCheckResult {
  if (status < 200 || status >= 300) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false };
  const body = parsed as { asOf?: unknown; blockers?: unknown; balances?: unknown };
  if (typeof body.asOf !== 'string' || body.asOf.length < 1) return { ok: false };
  if (!Array.isArray(body.blockers)) return { ok: false };
  const blockers: ClosureBlocker[] = [];
  for (const item of body.blockers) {
    const row = blocker(item);
    if (!row) return { ok: false };
    blockers.push(row);
  }
  const balances: ClosureBalance[] = [];
  if (body.balances !== undefined) {
    if (!Array.isArray(body.balances)) return { ok: false };
    for (const item of body.balances) {
      const row = balance(item);
      if (!row) return { ok: false };
      balances.push(row);
    }
  }
  return { ok: true, blockers, balances };
}

async function defaultFetch(url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
}

export function httpClosureChecker(options: { url: string | undefined; secret: string; fetchImpl?: ClosureFetch; timeoutMs?: number }): {
  check(input: { userId: string; subAccountIds: readonly string[] }): Promise<ClosureCheckResult>;
} {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async check(input) {
      const url = options.url?.trim();
      if (!url || !options.secret) return { ok: false };
      const body = JSON.stringify({ userId: input.userId, subAccountIds: [...input.subAccountIds] });
      const headers = {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-identity', options.secret, body),
      };
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        try {
          const response = await fetchImpl(`${url.replace(/\/$/, '')}/internal/closure-check`, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          const text = await response.text();
          const parsed = parseClosureCheckResponse(response.status, text);
          if (parsed.ok) return parsed;
        } catch {
          // Retry once. The reason stays off the log: a body can echo an account id.
        }
      }
      return { ok: false };
    },
  };
}
