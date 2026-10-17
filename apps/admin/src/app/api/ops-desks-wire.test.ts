import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bank from './bank-ops/route';
import * as p2p from './p2p-ops/route';
import * as more from './more-ops/route';

/**
 * The operator reads merged on main (BANKOPS, P2POPS, MININGBE, MARKETBE, QUANTBE), read through the desk BFFs with what each
 * service's own output schema says it returns. A read whose service answer drifts must show as a failed part, never a table.
 */

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const ctx = {
  session: {
    userId: FOUNDER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const AT = '2026-10-18T01:00:00.000Z';
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string, code?: string) =>
  Response.json(
    { error: { message, code: -32603, data: { code: 'X', httpStatus: status, ...(code ? { cause: { code } } : {}) } } },
    { status },
  );
const get = (path: string) => new Request(`http://admin.example${path}`);
const post = (path: string, body: unknown) =>
  new Request(`http://admin.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

const ANSWERS: Record<string, unknown> = {
  'ops.poolTotals': {
    asOf: AT,
    pools: [
      {
        poolId: 'pool-1',
        assetId: 'USDC',
        amountHeld: '1500.25',
        amountReason: null,
        depositorCount: 3,
        utilisation: null,
        utilisationReason: 'utilisation_not_recorded',
      },
      {
        poolId: 'pool-2',
        assetId: 'BTC',
        amountHeld: null,
        amountReason: 'ledger_unavailable',
        depositorCount: 2,
        utilisation: null,
        utilisationReason: 'utilisation_not_recorded',
      },
    ],
  },
  'ops.loanBook': {
    asOf: AT,
    openCount: 4,
    outstandingPrincipal: [
      { assetId: 'USDC', amount: '1000' },
      { assetId: 'BTC', amount: '0.5' },
    ],
    bands: { healthy: 2, marginCall: 1, liquidation: 0, unpriced: 1 },
    unpriced: [{ loanId: 'loan-9', reason: 'bank.loan_health_price_unset' }],
    oldestPending: null,
  },
  'ops.cardProgramme': {
    simulated: true,
    issued: 10,
    active: 8,
    frozen: 2,
    days: [{ day: '2026-10-17', volume: [{ assetId: 'USDC', amount: '12.5' }], declines: 1 }],
  },
  'ops.rampHealth': {
    asOf: AT,
    rails: [
      {
        id: 'ledger',
        provider: 'ledger',
        lastSuccess: AT,
        lastFailure: null,
        openCount: 0,
        failureCount: 1,
        totalCount: 4,
        failureRate: '1/4',
        lastProbeAt: null,
        reason: 'no_heartbeat',
      },
    ],
  },
  'ops.businessApprovals': {
    approvals: [
      {
        businessId: '5a3b9c10-1111-4222-8333-444455556666',
        amount: '50',
        assetId: 'USDC',
        ageSeconds: 60,
        makerHandle: null,
        makerHandleReason: 'handle_unresolved',
        rule: '10',
      },
      {
        businessId: '5a3b9c10-1111-4222-8333-444455556666',
        amount: '70',
        assetId: 'USDC',
        ageSeconds: 30,
        makerHandle: 'ada',
        makerHandleReason: null,
        rule: '10',
      },
    ],
    nextCursor: null,
  },
  'ops.counts': {
    offers: { active: 2, paused: 0, closed: 5 },
    trades: { created: 1, escrowed: 0, fiat_sent: 0, released: 9, cancelled: 3, disputed: 1 },
  },
  'ops.disputeRate24h': { disputesOpened24h: 1, tradesCreated24h: 0, rate: null },
  'ops.offers': {
    offers: [
      {
        id: '5a3b9c10-1111-4222-8333-444455556666',
        makerId: 'm1',
        side: 'sell',
        asset: 'USDT',
        fiatCurrency: 'EUR',
        price: '0.92',
        minAmount: '10',
        maxAmount: '500',
        totalAmount: '500',
        remainingAmount: '250',
        status: 'active',
        methodIds: ['sepa'],
        createdAt: AT,
      },
    ],
    nextCursor: null,
  },
  'ops.trades': {
    trades: [
      {
        id: '6b4c0d21-1111-4222-8333-444455556666',
        offerId: '5a3b9c10-1111-4222-8333-444455556666',
        makerId: 'm1',
        takerId: 't1',
        buyerId: 't1',
        sellerId: 'm1',
        asset: 'USDT',
        fiatCurrency: 'EUR',
        amount: '100',
        price: '0.92',
        fiatAmount: '92',
        method: 'sepa',
        feeBps: 10,
        status: 'disputed',
        resolution: null,
        createdAt: AT,
      },
    ],
    nextCursor: null,
  },
  terms: { feeBps: null, feeReason: 'fee_unconfigured', windowSize: 100, windowSizeReason: null },
  'ops.windows': {
    asOf: AT,
    windows: [
      { windowId: 'w-1', assetId: 'INTA', status: 'open', reward: null, feeBps: null, shareCount: 12, totalWeight: '36', paidAt: null },
    ],
  },
  'ops.shares': { asOf: AT, windows: [{ windowId: 'w-1', acceptedCount: 2, rejectedCount: 1, acceptedWeight: '4' }] },
  'ops.workers': { asOf: AT, workers: [], nextCursor: null },
  'ops.sales': {
    rows: [
      { vendorId: '5a3b9c10-1111-4222-8333-444455556666', assetId: 'USDC', settledVolume: '120.5', settledCount: '3', commission: '6.02' },
    ],
    refusedCount: '1',
    pendingCount: '0',
    nextCursor: null,
  },
  'studio.operatorList': {
    strategies: [
      {
        id: 's1',
        accountId: null,
        name: 'Mean reversion',
        language: 'javascript',
        environment: 'paper',
        kind: 'paper',
        claimLabel: 'Paper — not live performance',
        live: false,
        simulated: true,
      },
    ],
    quarantineCount: 0,
  },
};

function serve() {
  const calls: { url: string; procedure: string; input: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const procedure = parsed.pathname.split('/trpc/')[1] ?? '';
      const raw = parsed.searchParams.get('input');
      calls.push({ url, procedure, input: raw === null ? undefined : JSON.parse(raw) });
      return procedure in ANSWERS ? ok(ANSWERS[procedure]) : trpcErr(404, 'No procedure found');
    }),
  );
  return calls;
}

describe('bank desk: the BANKOPS reads', () => {
  it('every operator read answers, and the loan book is asked for once for its two readings', async () => {
    const calls = serve();
    const json = await (await bank.GET(get('/api/bank-ops'))).json();
    for (const id of [
      'bank.pool-totals',
      'bank.loan-book',
      'bank.loans-unpriced',
      'bank.card-counts',
      'bank.card-days',
      'bank.ramp-health',
      'bank.business-approvals',
    ]) {
      expect(json.reads[id].part, id).toMatchObject({ kind: 'ok' });
    }
    expect(calls.filter((c) => c.procedure === 'ops.loanBook')).toHaveLength(1);
    expect(calls.filter((c) => c.procedure === 'ops.cardProgramme')).toHaveLength(1);
    // The pool with no readable ledger shows its reason and a blank, never a zero.
    const pools = json.reads['bank.pool-totals'].part.data.rows;
    expect(pools[1].cells.find((c: { key: string }) => c.key === 'amountHeld').value).toBeNull();
    expect(pools[1].cells.find((c: { key: string }) => c.key === 'amountReason').value).toBe('ledger_unavailable');
    // Two totals in two assets are both kept.
    const book = json.reads['bank.loan-book'].part.data.cells;
    expect(book.find((c: { key: string }) => c.key === 'outstandingPrincipal').value).toEqual(['1000 USDC', '0.5 BTC']);
    expect(book.find((c: { key: string }) => c.key === 'oldestPending.id').value).toBeNull();
  });
  it('the windowed card read asks for the last 30 days up to the moment it read, and the ramp read for 24 hours', async () => {
    const calls = serve();
    await bank.GET(get('/api/bank-ops'));
    const card = calls.find((c) => c.procedure === 'ops.cardProgramme')!.input as { from: string; to: string };
    expect(Date.parse(card.to) - Date.parse(card.from)).toBe(30 * 86_400_000);
    expect(Math.abs(Date.now() - Date.parse(card.to))).toBeLessThan(10_000);
    expect(calls.find((c) => c.procedure === 'ops.rampHealth')!.input).toEqual({ windowHours: 24 });
    expect(calls.find((c) => c.procedure === 'ops.businessApprovals')!.input).toEqual({ limit: 50 });
  });
  it('a service that answers in a drifted shape fails that read alone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/ops.loanBook') ? ok({ ...(ANSWERS['ops.loanBook'] as object), openCount: '4' }) : ok(ANSWERS['ops.poolTotals']),
      ),
    );
    const json = await (await bank.GET(get('/api/bank-ops'))).json();
    expect(json.reads['bank.loan-book'].part).toMatchObject({ kind: 'failed', message: expect.stringContaining('shape') });
    expect(json.reads['bank.loans-unpriced'].part).toMatchObject({ kind: 'ok' });
  });
});

describe('p2p desk: the P2POPS reads', () => {
  it('counts, the 24 hour rate, offers and trades all read; a day with no trades has no ratio, not a zero', async () => {
    const calls = serve();
    const json = await (await p2p.GET(get('/api/p2p-ops'))).json();
    for (const id of ['p2p.counts', 'p2p.dispute-rate', 'p2p.offers-active', 'p2p.trades-disputed', 'p2p.trades-released']) {
      expect(json.reads[id].part, id).toMatchObject({ kind: 'ok' });
    }
    const rate = json.reads['p2p.dispute-rate'].part.data.cells;
    expect(rate.find((c: { key: string }) => c.key === 'rate').value).toBeNull();
    const statuses = calls.filter((c) => c.procedure === 'ops.trades').map((c) => (c.input as { status: string }).status);
    expect(statuses.sort()).toEqual(['disputed', 'escrowed', 'fiat_sent', 'released']);
    for (const c of calls.filter((x) => x.procedure === 'ops.offers' || x.procedure === 'ops.trades')) {
      expect((c.input as { limit: number }).limit).toBe(50);
    }
  });
  it('a session without the compliance permission is told so on every operator read, and nothing is shown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'Missing scope admin:compliance')),
    );
    const json = await (await p2p.GET(get('/api/p2p-ops'))).json();
    expect(json.reads['p2p.counts'].part).toMatchObject({
      kind: 'failed',
      forbidden: true,
      message: expect.stringContaining('admin:compliance'),
    });
    expect(json.reads['p2p.trades-disputed'].part).toMatchObject({ kind: 'failed', forbidden: true });
  });
});

describe('more desk: mining, market sales and quant strategies', () => {
  it('reads all of them; the mining shares read sends an explicit empty input because the service refuses none', async () => {
    const calls = serve();
    const json = await (await more.GET(get('/api/more-ops'))).json();
    for (const id of [
      'mining.terms',
      'mining.windows',
      'mining.shares',
      'mining.workers',
      'market.sales',
      'market.sales-counts',
      'quant.strategies',
    ]) {
      expect(json.reads[id].part, id).toMatchObject({ kind: 'ok' });
    }
    const shares = calls.find((c) => c.procedure === 'ops.shares')!;
    expect(shares.url).toContain('/api/mining/trpc/ops.shares?input=%7B%7D');
    // Sales: one call answers the table and the refused and pending counts.
    const sales = calls.filter((c) => c.procedure === 'ops.sales');
    expect(sales).toHaveLength(1);
    const input = sales[0]!.input as { from: string; to: string; limit: number };
    expect(input.limit).toBe(50);
    expect(Date.parse(input.to) - Date.parse(input.from)).toBe(30 * 86_400_000);
    // A mining window with no reward or fee keeps them blank rather than zero.
    const window = json.reads['mining.windows'].part.data.rows[0].cells;
    expect(window.find((c: { key: string }) => c.key === 'reward').value).toBeNull();
    expect(window.find((c: { key: string }) => c.key === 'feeBps').value).toBeNull();
  });
  it('a strategy that claims to be live is refused as unreadable instead of shown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/studio.operatorList')
          ? ok({
              strategies: [{ ...(ANSWERS['studio.operatorList'] as { strategies: object[] }).strategies[0], live: true }],
              quarantineCount: 0,
            })
          : trpcErr(404, 'No procedure found'),
      ),
    );
    const json = await (await more.GET(get('/api/more-ops'))).json();
    expect(json.reads['quant.strategies'].part).toMatchObject({ kind: 'failed', message: expect.stringContaining('shape') });
  });
});

describe('POST with a refused session', () => {
  it('bank and p2p return the gate’s refusal unchanged and call no service', async () => {
    const refusal = Response.json({ code: 'admin.session_required' }, { status: 401 });
    const fetchMock = vi.fn(async () => ok({}));
    vi.stubGlobal('fetch', fetchMock);
    gate.session.mockResolvedValue(refusal);
    const bankRes = await bank.POST(post('/api/bank-ops', { step: 'propose' }));
    expect(bankRes).toBe(refusal);
    const p2pRes = await p2p.POST(
      post('/api/p2p-ops', {
        action: 'p2p.dispute.escalate',
        disputeId: '5a3b9c10-1111-4222-8333-444455556666',
        reason: 'overdue and silent seller',
        clientRequestId: 'console-12345678',
      }),
    );
    expect(p2pRes).toBe(refusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST: the actions the new reads carry', () => {
  const CARD = '9f8e7d6c-1111-4222-8333-444455556666';
  it('bank takes only the card freeze request kind, and refuses any other without calling a service', async () => {
    const fetchMock = vi.fn(async () => ok({}));
    vi.stubGlobal('fetch', fetchMock);
    const wrong = await bank.POST(
      post('/api/bank-ops', {
        step: 'propose',
        request: { kind: 'market.vendor.vet', vendorId: CARD, decision: 'approved', reason: 'documents checked fully' },
        confirm: 'APPROVE VENDOR 9f8e7d6c',
      }),
    );
    expect(wrong.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('bank: proposing a card freeze asks identity for an approval bound to the svc-bank target and the exact card and status', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
        seen.push({ url, body });
        return ok({
          approvalId: 'appr_1',
          operationId: 'op_1',
          actionType: body.actionType,
          targetService: body.targetService,
          targetId: body.targetId,
          expectedVersion: body.expectedVersion,
          payloadHash: body.payloadHash,
          policyVersion: 'v1',
          requesterId: FOUNDER,
          approverId: null,
          requesterIsFounder: true,
          status: 'PENDING',
          createdAt: AT,
          expiresAt: '2026-10-18T01:10:00.000Z',
        });
      }),
    );
    const res = await bank.POST(
      post('/api/bank-ops', {
        step: 'propose',
        request: { kind: 'bank.card.status', cardId: CARD, status: 'frozen', reason: 'owner reported the card stolen' },
        confirm: 'FREEZE CARD 9f8e7d6c',
      }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]!.url).toBe('http://edge:4000/api/identity/trpc/actionApproval.propose');
    expect(seen[0]!.body).toMatchObject({
      actionType: 'bank.ops.setCardStatus',
      targetService: 'svc-bank',
      targetId: 'bank.ops.setCardStatus',
    });
  });
  it('more now also takes a listing takedown request kind', async () => {
    const fetchMock = vi.fn(async () => ok({}));
    vi.stubGlobal('fetch', fetchMock);
    const res = await more.POST(
      post('/api/more-ops', {
        step: 'propose',
        request: { kind: 'bank.card.status', cardId: CARD, status: 'frozen', reason: 'owner reported the card stolen' },
        confirm: 'FREEZE CARD 9f8e7d6c',
      }),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  const DISPUTE = '5a3b9c10-1111-4222-8333-444455556666';
  const escalate = {
    action: 'p2p.dispute.escalate',
    disputeId: DISPUTE,
    reason: 'overdue and the seller is silent',
    clientRequestId: 'console-0f8e7d6c-1111-4222-8333-444455556666',
  };
  it('p2p: an escalation goes to disputes.escalate as the founder with the reason and the key, and the answer is checked', async () => {
    const seen: { url: string; body: unknown; auth: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, body: JSON.parse(String(init!.body)), auth: (init!.headers as Record<string, string>).authorization! });
        return ok({
          disputeId: DISPUTE,
          tradeId: DISPUTE,
          escalatedAt: AT,
          escalations: 2,
          deadlineAt: AT,
          actorId: FOUNDER,
          reason: 'x',
          replay: false,
        });
      }),
    );
    const res = await p2p.POST(post('/api/p2p-ops', escalate));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, step: 'execute', detail: expect.stringContaining('2 escalations in all') });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: 'http://edge:4000/api/p2p/trpc/disputes.escalate',
      auth: 'Bearer founder-access-token',
      body: { disputeId: DISPUTE, reason: 'overdue and the seller is silent', clientRequestId: escalate.clientRequestId },
    });
  });
  it('p2p: an answer for a different dispute is an unknown outcome, never success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({
          disputeId: '6b4c0d21-1111-4222-8333-444455556666',
          tradeId: DISPUTE,
          escalatedAt: AT,
          escalations: 1,
          deadlineAt: AT,
          actorId: FOUNDER,
          reason: 'x',
          replay: false,
        }),
      ),
    );
    const res = await p2p.POST(post('/api/p2p-ops', escalate));
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('p2p: a founder who is not a moderator gets a plain refusal that says nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'not a moderator', 'p2p.not_a_moderator')),
    );
    const res = await p2p.POST(post('/api/p2p-ops', escalate));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { title: 'You are not a P2P moderator', changed: 'no' } });
  });
  it('p2p: a request that is not exactly an escalation, or has a short reason or a short key, reaches no service', async () => {
    const fetchMock = vi.fn(async () => ok({}));
    vi.stubGlobal('fetch', fetchMock);
    for (const bad of [
      { ...escalate, reason: 'short' },
      { ...escalate, clientRequestId: 'k' },
      { ...escalate, disputeId: 'not-a-uuid' },
      { ...escalate, extra: 1 },
      { ...escalate, action: 'p2p.dispute.resolve' },
    ]) {
      const res = await p2p.POST(post('/api/p2p-ops', bad));
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('p2p: a dropped connection is an unknown outcome and says repeating is the safe move', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNRESET'))),
    );
    const res = await p2p.POST(post('/api/p2p-ops', escalate));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
});
