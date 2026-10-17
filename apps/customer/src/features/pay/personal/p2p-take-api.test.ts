import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { createPayMutationGuard, createPersonalPayApi, wasPlacedUnderHeldReference } from '../pay-api';
import type { Offer, TakeQuote, Trade } from '../schemas';
import { takeRequest } from './p2p-model';

const ME = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';
const OFFER_ID = '33333333-3333-4333-8333-333333333333';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const offer = (over: Partial<Offer> = {}): Offer => ({
  id: OFFER_ID,
  makerId: MAKER,
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'EUR',
  priceType: 'fixed',
  price: '0.92',
  minAmount: '10',
  maxAmount: '500',
  remainingAmount: '300',
  methods: ['sepa'],
  terms: '',
  status: 'active',
  createdAt: '2026-10-17T00:00:00Z',
  ...over,
});
const quote = (over: Partial<TakeQuote> = {}): TakeQuote => ({
  amount: '100',
  price: '0.92',
  fiatAmount: '92',
  feeBps: 30,
  fee: '0.3',
  netAmount: '99.7',
  reservationExpiresAt: '2026-10-18T10:15:00.000Z',
  ...over,
});
const trade = (tradeId: string, over: Partial<Trade> = {}): Trade => ({
  id: tradeId,
  offerId: OFFER_ID,
  sellerId: MAKER,
  buyerId: ME,
  asset: 'USDT',
  amount: '100',
  fiatCurrency: 'EUR',
  fiatAmount: '92',
  price: '0.92',
  method: 'sepa',
  status: 'escrowed',
  resolution: null,
  deadlineAt: '2026-10-18T10:30:00.000Z',
  createdAt: '2026-10-18T10:00:00.000Z',
  escrowedAt: '2026-10-18T10:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
  ...over,
});
const asked = (current = offer()) => {
  const checked = takeRequest(current, '100', 'sepa');
  if (!checked.ok) throw new Error('fixture request is invalid');
  return checked.request;
};
const ok = (data: unknown) => new Response(JSON.stringify({ result: { data } }));
const refusal = (status: number, code: string, message = 'refused') =>
  new Response(JSON.stringify({ error: { message, data: { intafacedCode: code } } }), { status });

type Call = { procedure: string; method: string; body?: Record<string, unknown>; input?: Record<string, unknown> };
/** A tiny stand-in for svc-p2p. `routes` answer by procedure name; every call is recorded in order. */
function service(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const api = createApiClient({
    fetch: async (url, options) => {
      const parsed = new URL(String(url), 'http://isolated.invalid');
      const procedure = parsed.pathname.split('/').at(-1)!;
      const call: Call = {
        procedure,
        method: options?.method ?? 'GET',
        ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}),
        ...(parsed.searchParams.get('input') ? { input: JSON.parse(parsed.searchParams.get('input')!) } : {}),
      };
      calls.push(call);
      const route = routes[procedure];
      if (!route) throw new Error(`unexpected call ${procedure}`);
      return route(call);
    },
  });
  return { api, calls, posts: () => calls.filter((call) => call.method === 'POST') };
}
const fresh = () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  return { guard: createPayMutationGuard(storage), values };
};
const journalKey = `${ME}:take:${OFFER_ID}`;
const reviewed = (q = quote()) => ({ quote: q, current: () => true });

describe('quoting a take', () => {
  it('asks the service for the exact request and returns its figures unchanged', async () => {
    const svc = service({ 'trades.quote': () => ok(quote()) });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    const result = await pay.quoteTake(offer(), asked());
    expect(result).toEqual({ ok: true, data: quote() });
    expect(svc.calls).toEqual([{ procedure: 'trades.quote', method: 'GET', input: { offerId: OFFER_ID, amount: '100', method: 'sepa' } }]);
  });
  it('shows no quote that does not add up', async () => {
    const svc = service({ 'trades.quote': () => ok(quote({ netAmount: '100' })) });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.quoteTake(offer(), asked())).toMatchObject({ ok: false, code: 'pay.take_quote_invalid' });
  });
  it('shows no quote for another quantity than the one asked for', async () => {
    const svc = service({ 'trades.quote': () => ok(quote({ amount: '101', fee: '0.303', netAmount: '100.697' })) });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.quoteTake(offer(), asked())).toMatchObject({ ok: false, code: 'pay.take_quote_invalid' });
  });
  it('sends nothing for the signed-in maker’s own offer', async () => {
    const svc = service({});
    const pay = createPersonalPayApi(svc.api, MAKER, fresh().guard);
    expect(await pay.quoteTake(offer(), asked())).toMatchObject({ ok: false, code: 'pay.take_own_offer' });
    expect(svc.calls).toHaveLength(0);
  });
});

describe('placing an order', () => {
  const happy = (extra: Record<string, (call: Call) => Response | Promise<Response>> = {}) =>
    service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': (call) => ok(trade(String(call.body!.tradeId))),
      ...extra,
    });

  it('sends one take under a client-chosen order id, then clears the stored id', async () => {
    const svc = happy();
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    const result = await pay.takeOffer(offer(), asked(), reviewed());
    expect(result).toMatchObject({ ok: true, data: { status: 'escrowed' } });
    expect(svc.posts()).toHaveLength(1);
    const body = svc.posts()[0]!.body!;
    expect(body).toEqual({ offerId: OFFER_ID, tradeId: expect.stringMatching(UUID), amount: '100', method: 'sepa' });
    expect(result.ok && result.data.id).toBe(body.tradeId);
    expect(guard.status(journalKey)).toBe(null);
  });
  it('reads the offer and the quote again first and sends nothing if the figures moved since review', async () => {
    const svc = happy({ 'trades.quote': () => ok(quote({ feeBps: 50, fee: '0.5', netAmount: '99.5' })) });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, code: 'pay.take_quote_changed' });
    expect(svc.posts()).toHaveLength(0);
  });
  it('sends nothing if the offer’s terms changed since review', async () => {
    const svc = happy({ 'offers.get': () => ok(offer({ price: '0.95' })) });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, code: 'pay.take_terms_changed' });
    expect(svc.posts()).toHaveLength(0);
  });
  it('lets the remaining quantity shrink between review and confirm, but not the terms', async () => {
    const svc = happy({ 'offers.get': () => ok(offer({ remainingAmount: '150' })) });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: true });
  });
  it('sends nothing if the offer is no longer open', async () => {
    const svc = happy({ 'offers.get': () => ok(offer({ status: 'paused' })) });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, code: 'pay.take_offer_unavailable' });
    expect(svc.posts()).toHaveLength(0);
  });
  it('never sends a take on the signed-in person’s own offer', async () => {
    const svc = happy();
    const pay = createPersonalPayApi(svc.api, MAKER, fresh().guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, code: 'pay.take_own_offer' });
    expect(svc.calls).toHaveLength(0);
  });
  it('does not accept a reply that is not the order that was reviewed', async () => {
    const svc = happy({ 'trades.take': (call) => ok(trade(String(call.body!.tradeId), { amount: '400', fiatAmount: '368' })) });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(guard.status(journalKey)).toBe('uncertain');
  });
  it('treats a definite refusal as nothing placed and frees the next attempt', async () => {
    const svc = happy({ 'trades.take': () => refusal(400, 'p2p.amount_below_min') });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, code: 'p2p.amount_below_min' });
    expect(guard.status(journalKey)).toBe(null);
  });
  it('keeps a conflict or a failed lock unconfirmed, because the order may exist', async () => {
    for (const [status, code] of [
      [412, 'p2p.escrow_lock_uncertain'],
      [409, 'p2p.trade_moved'],
      [500, 'p2p.unknown'],
    ] as const) {
      const svc = happy({
        'trades.take': () => refusal(status, code),
        'trades.get': () => refusal(404, 'p2p.trade_not_found'),
      });
      const { guard } = fresh();
      const pay = createPersonalPayApi(svc.api, ME, guard);
      expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, reason: 'uncertain' });
      expect(guard.status(journalKey)).toBe('uncertain');
    }
  });
  it('answers “already placed” with the order the service holds instead of a second one', async () => {
    const svc = happy({
      'trades.take': () => refusal(409, 'p2p.trade_exists'),
      'trades.get': (call) => ok(trade(String(call.input!.tradeId))),
    });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: true });
    expect(svc.posts()).toHaveLength(1);
    expect(guard.status(journalKey)).toBe(null);
  });
});

describe('a lost reply', () => {
  /**
   * The first take never gets an answer (the connection ends) and, while the network is down, the look-up by id fails
   * too. The service may or may not have placed it; `recover()` brings the network back.
   */
  function lost(placed: boolean) {
    let placedId: string | null = null;
    let posts = 0;
    let down = true;
    const svc = service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': (call) => {
        posts += 1;
        const tradeId = String(call.body!.tradeId);
        if (posts === 1) {
          if (placed) placedId = tradeId;
          return refusal(503, 'gateway.timeout');
        }
        // Like the service: offer, limit and liquidity checks come first. An earlier take that landed has used the
        // quantity up, so the repeat is refused for liquidity and `trade_exists` is never reached.
        if (placedId) return refusal(400, 'p2p.insufficient_offer_liquidity');
        placedId = tradeId;
        return ok(trade(tradeId));
      },
      'trades.get': (call) =>
        down
          ? refusal(503, 'gateway.timeout')
          : placedId === String(call.input!.tradeId)
            ? ok(trade(placedId))
            : refusal(404, 'p2p.trade_not_found'),
    });
    return { ...svc, recover: () => void (down = false) };
  }

  it('stores the order id before the request leaves and reports the outcome as unconfirmed', async () => {
    const svc = lost(true);
    const { guard, values } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, reason: 'uncertain' });
    const sent = String(svc.posts()[0]!.body!.tradeId);
    expect(guard.reference(journalKey)).toBe(sent);
    expect(values.get('pay.unresolved:' + journalKey)).toContain(sent);
    expect(svc.posts()).toHaveLength(1);
  });
  it('succeeds at once when the reply is lost but the order can be read back by its id', async () => {
    const svc = lost(true);
    svc.recover();
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    const result = await pay.takeOffer(offer(), asked(), reviewed());
    expect(result).toMatchObject({ ok: true, data: { status: 'escrowed' } });
    expect(svc.posts()).toHaveLength(1);
    expect(guard.status(journalKey)).toBe(null);
  });
  it('finds the order by its id when it was placed, and clears the stored id', async () => {
    const svc = lost(true);
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    const sent = String(svc.posts()[0]!.body!.tradeId);
    svc.recover();
    const found = await pay.reconcileTake(offer());
    expect(found).toMatchObject({ ok: true, data: { id: sent, status: 'escrowed' } });
    expect(guard.status(journalKey)).toBe(null);
    expect(svc.posts()).toHaveLength(1);
  });
  it('says nothing was found when it was not placed, and keeps the stored id', async () => {
    const svc = lost(false);
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    svc.recover();
    expect(await pay.reconcileTake(offer())).toMatchObject({ ok: false, reason: 'uncertain', code: 'pay.take_not_found' });
    expect(guard.status(journalKey)).toBe('uncertain');
  });
  it('does not retry by itself: a second take is a deliberate act, and it reuses the same order id', async () => {
    const svc = lost(false);
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    expect(svc.posts()).toHaveLength(1);
    const first = String(svc.posts()[0]!.body!.tradeId);
    svc.recover();
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: true });
    expect(svc.posts()).toHaveLength(2);
    expect(String(svc.posts()[1]!.body!.tradeId)).toBe(first);
    expect(guard.status(journalKey)).toBe(null);
  });
  it('places nothing a second time when the first did land: the existing order comes back', async () => {
    const svc = lost(true);
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    const first = String(svc.posts()[0]!.body!.tradeId);
    svc.recover();
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: true, data: { id: first } });
    // The order was looked up by id first, so no second request was even sent.
    expect(svc.posts()).toHaveLength(1);
    expect(guard.status(journalKey)).toBe(null);
  });
  it('survives a reload: a new api over the same storage still sees the stored order id', async () => {
    const svc = lost(true);
    const { guard, values } = fresh();
    await createPersonalPayApi(svc.api, ME, guard).takeOffer(offer(), asked(), reviewed());
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    const reopened = createPayMutationGuard(storage);
    expect(reopened.reference(journalKey)).toBe(String(svc.posts()[0]!.body!.tradeId));
    svc.recover();
    const found = await createPersonalPayApi(svc.api, ME, reopened).reconcileTake(offer());
    expect(found).toMatchObject({ ok: true });
  });

  it('does not call the order unplaced when the resend is refused only because the first attempt landed late', async () => {
    let gets = 0;
    let posts = 0;
    let firstId = '';
    const svc = service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': (call) => {
        posts += 1;
        if (posts === 1) {
          firstId = String(call.body!.tradeId);
          return refusal(503, 'gateway.timeout');
        }
        // The first attempt has committed in the meantime and used the quantity up.
        return refusal(400, 'p2p.insufficient_offer_liquidity');
      },
      // Not committed at the first two looks; committed by the look after the refusal.
      'trades.get': () => (++gets >= 3 ? ok(trade(firstId)) : refusal(404, 'p2p.trade_not_found')),
    });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, reason: 'uncertain' });
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: true, data: { id: firstId } });
    expect(String(svc.posts()[1]!.body!.tradeId)).toBe(firstId);
    expect(guard.status(journalKey)).toBe(null);
  });
  it('reports a refused resend as nothing placed only after the order was looked for again and not found', async () => {
    let posts = 0;
    const svc = service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': () => (++posts === 1 ? refusal(503, 'gateway.timeout') : refusal(400, 'p2p.insufficient_offer_liquidity')),
      'trades.get': () => refusal(404, 'p2p.trade_not_found'),
    });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: false, code: 'p2p.insufficient_offer_liquidity' });
    expect(svc.calls.filter((call) => call.procedure === 'trades.get').length).toBeGreaterThanOrEqual(3);
    expect(guard.status(journalKey)).toBe(null);
  });
  it('keeps the stored id and says unconfirmed when the look-up before a resend cannot be answered', async () => {
    const svc = lost(false);
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    // The network is still down, so the look-up fails. That is not "not found".
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: false, reason: 'uncertain', code: 'pay.take_unconfirmed' });
    expect(svc.posts()).toHaveLength(1);
    expect(guard.status(journalKey)).toBe('uncertain');
  });
  it('keeps the stored id when the look-up after a refused resend cannot be answered', async () => {
    let posts = 0;
    let gets = 0;
    const svc = service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': () => (++posts === 1 ? refusal(503, 'gateway.timeout') : refusal(400, 'p2p.insufficient_offer_liquidity')),
      'trades.get': () => (++gets <= 2 ? refusal(404, 'p2p.trade_not_found') : refusal(503, 'gateway.timeout')),
    });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({
      ok: false,
      reason: 'uncertain',
      code: 'pay.take_unconfirmed',
    });
    expect(guard.status(journalKey)).toBe('uncertain');
  });
});

describe('verification and region refusals', () => {
  it('are definite, and the service never sees a second request', async () => {
    for (const code of ['denied.kyc_required', 'denied.region_blocked', 'denied.region_unknown']) {
      const svc = service({ 'offers.get': () => ok(offer()), 'trades.quote': () => refusal(403, code) });
      const { guard } = fresh();
      const pay = createPersonalPayApi(svc.api, ME, guard);
      expect(await pay.quoteTake(offer(), asked())).toMatchObject({ ok: false, code });
      expect(await pay.takeOffer(offer(), asked(), reviewed())).toMatchObject({ ok: false, code });
      expect(svc.posts()).toHaveLength(0);
      expect(guard.status(journalKey)).toBe(null);
    }
  });
});

describe('a resend under the held reference', () => {
  const bare404 = () => new Response('', { status: 404 });
  it('clears the stored id only on the service’s own “no such order” answer; a bare 404 is unconfirmed', async () => {
    let posts = 0;
    let gets = 0;
    const svc = service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': () => (++posts === 1 ? refusal(503, 'gateway.timeout') : refusal(400, 'p2p.insufficient_offer_liquidity')),
      // The first look-up is the service's answer; the look-up after the refusal is a bare 404 with no code.
      'trades.get': () => (++gets <= 1 ? refusal(404, 'p2p.trade_not_found') : bare404()),
    });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: false, reason: 'uncertain', code: 'pay.take_unconfirmed' });
    expect(guard.status(journalKey)).toBe('uncertain');
  });
  it('does not resend at all when the first look-up is a bare 404', async () => {
    let posts = 0;
    const svc = service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': () => (++posts === 1 ? refusal(503, 'gateway.timeout') : ok(trade('x'))),
      'trades.get': () => bare404(),
    });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: false, reason: 'uncertain', code: 'pay.take_unconfirmed' });
    expect(svc.posts()).toHaveLength(1);
    expect(guard.status(journalKey)).toBe('uncertain');
  });
  it('marks an order that the resend placed for the first time, and not one the service already had', async () => {
    let posts = 0;
    let placedId: string | null = null;
    let down = true;
    const svc = service({
      'offers.get': () => ok(offer()),
      'trades.quote': () => ok(quote()),
      'trades.take': (call) => {
        if (++posts === 1) return refusal(503, 'gateway.timeout');
        placedId = String(call.body!.tradeId);
        return ok(trade(placedId));
      },
      'trades.get': (call) =>
        down
          ? refusal(503, 'gateway.timeout')
          : placedId === String(call.input!.tradeId)
            ? ok(trade(placedId))
            : refusal(404, 'p2p.trade_not_found'),
    });
    const { guard } = fresh();
    const pay = createPersonalPayApi(svc.api, ME, guard);
    await pay.takeOffer(offer(), asked(), reviewed());
    down = false;
    const again = await pay.takeOffer(offer(), asked(), reviewed());
    expect(again).toMatchObject({ ok: true });
    if (again.ok) expect(wasPlacedUnderHeldReference(again.data)).toBe(true);

    // The first attempt did land: the resend finds it and places nothing.
    const landed = (() => {
      let id = '';
      let n = 0;
      return service({
        'offers.get': () => ok(offer()),
        'trades.quote': () => ok(quote()),
        'trades.take': (call) => {
          if (++n === 1) id = String(call.body!.tradeId);
          return refusal(503, 'gateway.timeout');
        },
        'trades.get': (call) => (n > 0 && String(call.input!.tradeId) === id && !down2() ? ok(trade(id)) : refusal(503, 'gateway.timeout')),
      });
    })();
    let isDown = true;
    function down2() {
      return isDown;
    }
    const second = fresh();
    const pay2 = createPersonalPayApi(landed.api, ME, second.guard);
    await pay2.takeOffer(offer(), asked(), reviewed());
    isDown = false;
    const found = await pay2.takeOffer(offer(), asked(), reviewed());
    expect(found).toMatchObject({ ok: true });
    if (found.ok) expect(wasPlacedUnderHeldReference(found.data)).toBe(false);
  });
});

describe('the seller’s available balance', () => {
  const balance = (balances: Record<string, { free: string; used: string; total: string }>) =>
    service({ balance: () => new Response(JSON.stringify({ timestamp: 1, datetime: '2026-10-18T10:00:00.000Z', balances })) });
  it('reads the free quantity of the asset from the account balance read', async () => {
    const svc = balance({ USDT: { free: '530.152142', used: '10', total: '540.152142' } });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.availableBalance('USDT')).toEqual({ ok: true, data: '530.152142' });
  });
  it('treats an asset the read does not list as none held', async () => {
    const svc = balance({ BTC: { free: '1', used: '0', total: '1' } });
    const pay = createPersonalPayApi(svc.api, ME, fresh().guard);
    expect(await pay.availableBalance('USDT')).toEqual({ ok: true, data: '0' });
  });
  it('returns the failure when the read fails, and reads nothing when signed out', async () => {
    const down = service({ balance: () => new Response('', { status: 503 }) });
    expect(await createPersonalPayApi(down.api, ME, fresh().guard).availableBalance('USDT')).toMatchObject({ ok: false });
    const out = service({});
    expect(await createPersonalPayApi(out.api, null, fresh().guard).availableBalance('USDT')).toMatchObject({
      ok: false,
      reason: 'unauthorized',
    });
    expect(out.calls).toHaveLength(0);
  });
});
