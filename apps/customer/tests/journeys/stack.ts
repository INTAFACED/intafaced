import { randomBytes, randomUUID } from 'node:crypto';
import { encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { formatAmount, parseAmount, recipes } from '@intafaced/ledger-client';
import { createApiClient } from '../../src/shared/api';
import { createTradeApi } from '../../src/features/trade/trade-api';

/**
 * The assembled stack a journey runs against. Every value comes from the environment the boot script
 * (`tooling/scripts/order-path-cx8-boot.mjs`) exports; a missing one fails the run, it is never defaulted here.
 */
function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`journey stack: ${name} is not set. Run through "pnpm journeys:trade" so the stack is booted first.`);
  return value;
}

export const stack = {
  trade: () => need('TRADE_HTTP_URL').replace(/\/$/, ''),
  ledger: () => need('LEDGER_HTTP_URL').replace(/\/$/, ''),
  identity: () => need('IDENTITY_HTTP_URL').replace(/\/$/, ''),
  edgeSecret: () => need('EDGE_PRINCIPAL_SECRET'),
  internalSecret: () => need('INTERNAL_SERVICE_SECRET'),
  region: () => process.env.TRADE_SMOKE_REGION?.trim() || 'DE',
  symbol: () => process.env.TRADE_SMOKE_SYMBOL?.trim() || 'BTC/USDT',
};

type Session = { userId: string; sid: string; scopes: string[]; tier: string; mfa: boolean; exp: number };

/** What the edge does for a signed-in customer: it turns the session into a signed principal header for trade. */
function edgeHeaders(session: Session): Record<string, string> {
  const raw = encodePrincipal({
    sub: session.userId,
    userId: session.userId,
    sid: session.sid,
    scopes: session.scopes,
    tier: session.tier,
    mfa: session.mfa,
    expiresAt: new Date(session.exp * 1000),
  } as never);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, stack.edgeSecret(), stack.region()),
    'x-intafaced-region': stack.region(),
  };
}

export type FetchLog = { method: string; path: string; status: number }[];

/**
 * A fetch for the customer's own ApiClient. The client asks for `/api/v1/...` on its own origin; this sends that call to
 * the real trade service with the edge's principal header. Nothing is answered here: every response is the service's.
 * `dropResponses` loses the answer to the next N order placements AFTER the service has handled them, which is what a
 * network drop between trade and the browser looks like.
 */
export function customerFetch(session: Session, opts: { dropResponses?: { n: number } } = {}) {
  const calls: FetchLog = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://customer.invalid');
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined), ...edgeHeaders(session) };
    delete headers.authorization;
    const method = init?.method ?? 'GET';
    const response = await fetch(stack.trade() + url.pathname + url.search, { ...init, headers });
    calls.push({ method, path: url.pathname, status: response.status });
    if (method === 'POST' && url.pathname === '/api/v1/orders' && opts.dropResponses && opts.dropResponses.n > 0) {
      opts.dropResponses.n -= 1;
      await response.arrayBuffer();
      throw new TypeError('fetch failed');
    }
    return response;
  }) as typeof fetch;
  return { fetcher, calls };
}

/**
 * A real customer: signed up at identity (the public door, as the app's sign-up does), so trade's account check sees a
 * live account. The session claims come from the access token identity issued.
 */
export async function newCustomer(opts: Parameters<typeof customerFetch>[1] & { unverified?: boolean } = {}) {
  const handle = `journey_${randomBytes(5).toString('hex')}`;
  const response = await fetch(`${stack.identity()}/trpc/auth.register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      handle,
      email: `${handle}@example.test`,
      password: randomBytes(18).toString('base64url'),
      region: stack.region(),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`identity auth.register ${response.status}: ${text.slice(0, 300)}`);
  const issued = JSON.parse(text).result.data as { userId: string; accessToken: string };
  const claims = JSON.parse(Buffer.from(issued.accessToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const session: Session = {
    userId: issued.userId,
    sid: String(claims.sid),
    scopes: ['trade:read', 'trade:write'],
    // Trade gates on the verification tier the edge forwards. Identity's KYC review is its own journey; until that one is
    // wired, a journey customer is forwarded as tier "basic" (what a reviewed account carries) unless `unverified`.
    tier: opts.unverified ? String(claims.tier ?? 'none') : 'basic',
    mfa: claims.mfa === true,
    exp: Number(claims.exp),
  };
  return signedIn(session, opts);
}

function signedIn(session: Session, opts: Parameters<typeof customerFetch>[1]) {
  const { fetcher, calls } = customerFetch(session, opts);
  const api = createApiClient({ fetch: fetcher, token: () => 'journey-session' });
  return {
    userId: session.userId,
    api,
    trade: createTradeApi(api),
    calls,
    /** The same person on a connection that loses answers. */
    again: (again: Parameters<typeof customerFetch>[1]) => signedIn(session, again),
  };
}
export type Customer = Awaited<ReturnType<typeof newCustomer>>;

async function ledgerCall(path: string, body: unknown): Promise<unknown> {
  const raw = JSON.stringify(body);
  const response = await fetch(stack.ledger() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', stack.internalSecret(), raw) },
    body: raw,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ledger ${path} ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Put TEST funds on a journey customer's account through the ledger deposit recipe. Business key, so a rerun adds nothing. */
export async function fund(userId: string, assetId: string, amount: string): Promise<void> {
  const request = recipes.deposit({
    userId,
    assetId,
    amount: parseAmount(amount),
    rail: 'journey-test',
    railRef: `journey:${assetId}:${userId}`,
  });
  await ledgerCall('/trpc/post', {
    ...request,
    entries: request.entries.map((e) => ({ ...e, amount: typeof e.amount === 'bigint' ? formatAmount(e.amount) : e.amount })),
  });
}

/** The ledger's own available balance, read directly: the proof that does not go through trade. */
export async function ledgerAvailable(userId: string, assetId: string): Promise<string> {
  const json = (await ledgerCall('/trpc/balance', { ownerType: 'user', ownerId: userId, assetId, kind: 'available' })) as {
    amount?: string;
  };
  return String(json.amount ?? '0');
}

export async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`journey: timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}
