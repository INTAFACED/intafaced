import { randomBytes, randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { formatAmount, parseAmount, recipes } from '@intafaced/ledger-client';
import { claimsOf, hashOf, identityCall, randomHandle, type Claims, type Issued } from './identity';
import { createApiClient } from '../../src/shared/api';
import { createTradeApi } from '../../src/features/trade/trade-api';

export { stack } from './env';
import { stack } from './env';

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

/** What the customer has done at identity: nothing yet, a KYC request filed, or the request approved by two operators. */
export type Onboarding = 'signed_up' | 'kyc_pending' | 'kyc_approved';

/**
 * A real customer: signed up at identity (the public door, as the app's sign-up does), so trade's account check sees a live
 * account. Verification is identity's own path: the customer files a request, two operators approve it (one proposes, a
 * different one approves, each on an MFA session), and the customer signs in again, so the tier trade sees is the one in the
 * access token identity issued. Nothing is forwarded or forced.
 */
export async function newCustomer(opts: Parameters<typeof customerFetch>[1] & { onboarding?: Onboarding } = {}) {
  const onboarding = opts.onboarding ?? 'kyc_approved';
  const handle = randomHandle('journey');
  const email = `${handle}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const issued = await identityCall<Issued>('auth.register', { handle, email, password, region: stack.region() }, null);
  let claims = claimsOf(issued.accessToken);
  let recordId: string | null = null;
  if (onboarding !== 'signed_up') {
    const record = await identityCall<{ id: string }>('kyc.submit', { tier: 'basic', jurisdiction: stack.region() }, claims);
    recordId = record.id;
  }
  const customer = {
    userId: issued.userId,
    handle,
    email,
    password,
    recordId,
    /** Two operators approve the pending request; the customer signs in again so the tier reaches the session. */
    async approveKyc() {
      if (!this.recordId) throw new Error('no KYC request filed');
      const [proposer, approver] = inject('operators');
      const fields = { recordId: this.recordId };
      const payloadHash = hashOf('kyc.approve', fields);
      const proposed = await identityCall<{ approvalId: string }>(
        'actionApproval.propose',
        {
          actionType: 'kyc.approve',
          targetService: 'svc-identity',
          targetId: 'kyc.approve',
          expectedVersion: '1',
          payloadHash,
          policyVersion: 'local-test:journey-v1',
        },
        proposer,
      );
      const approved = await identityCall<{ approvalId: string; operationId: string; approverId: string }>(
        'actionApproval.approve',
        { approvalId: proposed.approvalId, expectedPayloadHash: payloadHash },
        approver,
      );
      await identityCall(
        'kyc.approve',
        {
          recordId: this.recordId,
          approvalId: approved.approvalId,
          operationId: approved.operationId,
          confirmOperatorId: approved.approverId,
        },
        proposer,
      );
    },
    /** A fresh sign-in: the tier in the new access token is whatever identity now says. */
    async signIn() {
      const again = await identityCall<Issued>('auth.login', { identifier: email, password }, null);
      return signedIn(sessionOf(claimsOf(again.accessToken), issued.userId), opts, customer);
    },
  };
  if (onboarding === 'kyc_approved') await customer.approveKyc();
  claims = claimsOf((await identityCall<Issued>('auth.login', { identifier: email, password }, null)).accessToken);
  return signedIn(sessionOf(claims, issued.userId), opts, customer);
}

function sessionOf(claims: Claims, userId: string): Session {
  return { userId, sid: claims.sid, scopes: claims.scopes, tier: claims.tier, mfa: claims.mfa, exp: claims.exp };
}

type Account = {
  userId: string;
  handle: string;
  email: string;
  password: string;
  approveKyc(): Promise<void>;
  signIn(): Promise<Customer>;
};

function signedIn(session: Session, opts: Parameters<typeof customerFetch>[1], account: Account) {
  const { fetcher, calls } = customerFetch(session, opts);
  const api = createApiClient({ fetch: fetcher, token: () => 'journey-session' });
  return {
    userId: session.userId,
    session,
    account,
    api,
    trade: createTradeApi(api),
    calls,
    /** The same person on a connection that loses answers. */
    again: (again: Parameters<typeof customerFetch>[1]) => signedIn(session, again, account),
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
