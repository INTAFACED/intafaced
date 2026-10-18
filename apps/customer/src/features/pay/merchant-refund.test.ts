import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { createBusinessPayApi, createPayMutationGuard } from './pay-api';
import { HISTORY_WINDOW, refundCopy, refundFailureKey } from './merchant-refund-copy';
import type { JournalLocks } from '../../shared/minimal-original-journal';

const userId = '11111111-1111-4111-8111-111111111111';
const merchantId = '22222222-2222-4222-8222-222222222222';
const paymentId = '33333333-3333-4333-8333-333333333333';
const refundId = `refund:${paymentId}:44444444-4444-4444-8444-444444444444`;
const authority = {
  verified: true as const,
  companyId: 'isolated-company',
  companyName: 'Isolated company',
  userId,
  merchantId,
  scopes: ['pay:read', 'pay:refund'],
};
const merchant = {
  id: merchantId,
  userId,
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: 'isolated-approved',
  feeBps: null,
};
const response = (data: unknown) => new Response(JSON.stringify({ result: { data } }));
const payment = {
  id: paymentId,
  merchantId,
  profileId: null,
  amount: '100',
  assetId: 'USDT',
  method: 'isolated-method',
  railAdapter: 'isolated-rail',
  railRef: 'isolated-reference',
  status: 'captured',
  capturedAmount: '100',
  refundedAmount: '0',
  createdAt: '2026-10-10T09:00:00Z',
};

describe('Merchant original refund recovery', () => {
  it('retains the exact opaque original after a lost refund reply across independent callers', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const guard = createPayMutationGuard(storage);
    const api = createApiClient({
      fetch: async (url, options) =>
        options?.method === 'POST'
          ? new Response('{}', { status: 503 })
          : response(String(url).includes('merchant.me') ? merchant : String(url).includes('payment.history') ? [] : payment),
    });
    const locks = { request: async (_name: string, _options: unknown, work: (lock: unknown) => unknown) => work({}) } as JournalLocks;
    const pay = createBusinessPayApi(api, userId, authority, guard, { durable: () => storage, locks: () => locks });
    await pay.refund.submit(
      { paymentId, amount: '25', refundId },
      () => true,
      () => true,
    );
    expect(createPayMutationGuard(storage).reference(`${userId}:payment:${paymentId}`)).toBe(refundId);
  });
});

describe('A refund whose confirmation ran out before the send', () => {
  it('clears the saved original on a 401, so the same review and the same refund reference go out once more', async () => {
    const env = device();
    const bodies: string[] = [];
    let answer401 = true;
    const history = [event()];
    const api = createApiClient({
      fetch: async (url, options) => {
        const text = String(url);
        if (options?.method === 'POST') {
          bodies.push(String(options.body));
          if (answer401) return new Response(JSON.stringify({ error: { message: 'no', data: { code: 'UNAUTHORIZED' } } }), { status: 401 });
          return response(payment);
        }
        return response(text.includes('merchant.me') ? merchant : text.includes('payment.history') ? (answer401 ? [] : history) : payment);
      },
    });
    const pay = createBusinessPayApi(api, userId, authority, createPayMutationGuard(env.storage), env.ports);
    const input = { paymentId, amount: '25', refundId };
    const yes = () => true;
    const first = await pay.refund.submit(input, yes, yes);
    // Nothing was refunded: the gateway turned the token away before the refund service saw it. No unresolved original is kept.
    expect(first).toMatchObject({ ok: false, code: 'pay.refund_step_up_expired' });
    expect(env.values.get(operationKey)).toBeUndefined();
    expect(refundFailureKey({ code: 'pay.refund_step_up_expired', busy: false, referenceHeld: false })).toBe('stepExpired');
    // The person confirms again: the same input, with the same refund reference, is sent again and is recorded.
    answer401 = false;
    const second = await pay.refund.submit(input, yes, yes);
    expect(second).toMatchObject({ ok: true });
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0]!)).toEqual(JSON.parse(bodies[1]!));
    expect(JSON.parse(bodies[1]!).refundId).toBe(refundId);
  });
});

function device() {
  const values = new Map<string, string>(),
    legacy = new Map<string, string>(),
    held = new Set<string>();
  const fault = { read: false, write: false, silentWrite: false, remove: false, silentRemove: false };
  const storage = {
    getItem: (key: string) => {
      if (fault.read) throw Error('Denied read');
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (fault.write) throw Error('Quota');
      if (!fault.silentWrite) values.set(key, value);
    },
    removeItem: (key: string) => {
      if (fault.remove) throw Error('Denied removal');
      if (!fault.silentRemove) values.delete(key);
    },
  };
  const session = {
    getItem: (key: string) => legacy.get(key) ?? null,
    setItem: (key: string, value: string) => {
      legacy.set(key, value);
    },
    removeItem: (key: string) => {
      legacy.delete(key);
    },
  };
  const locks = {
    request: async (name: string, _options: unknown, work: (lock: unknown) => Promise<unknown>) => {
      if (held.has(name)) return work(null);
      held.add(name);
      try {
        return await work({ name });
      } finally {
        held.delete(name);
      }
    },
  } as JournalLocks;
  return { values, legacy, fault, storage, ports: { durable: () => storage, legacy: () => session, locks: () => locks } };
}
const operationKey = `pay.unresolved:${userId}:payment:${paymentId}`;
const originalRaw = JSON.stringify({ status: 'uncertain', reference: refundId });
const event = (name = 'refunded', reference = refundId, amount: unknown = '25') => ({
  id: '55555555-5555-4555-8555-555555555555',
  event: name,
  payload: { refundId: reference, amount },
  railEventId: null,
  ts: '2026-10-10T09:42:00Z',
});
function fixture(d = device()) {
  const state = {
    history: [] as unknown[],
    payment: { ...payment },
    current: true,
    postStatus: 200,
    posts: [] as unknown[],
    gets: [] as string[],
    hold: null as null | Promise<void>,
    holdHistory: null as null | Promise<void>,
  };
  const api = createApiClient({
    canWrite: () => state.current,
    fetch: async (url, options) => {
      const name = String(url).split('/').at(-1)!.split('?')[0]!;
      if (options?.method === 'POST') {
        state.posts.push(JSON.parse(String(options.body)));
        return state.postStatus === 200
          ? response(state.payment)
          : new Response(JSON.stringify({ error: { message: 'Isolated refusal', data: { intafacedCode: 'pay.refund_rail_failed' } } }), {
              status: state.postStatus,
            });
      }
      state.gets.push(name);
      if (name === 'merchant.me') {
        if (state.hold) await state.hold;
        return response(merchant);
      }
      if (name === 'payment.history') {
        if (state.holdHistory) await state.holdHistory;
        return response(state.history);
      }
      return response(state.payment);
    },
  });
  const create = () => createBusinessPayApi(api, userId, authority, createPayMutationGuard(d.storage), d.ports).refund;
  return { d, state, create, refund: create(), api };
}
const input = { paymentId, amount: '25', refundId };
const current = () => true;

describe('Refund-specific terminal evidence', () => {
  it('known cleanup outlives only its originating read attempt, within the same owner context', async () => {
    const f = fixture();
    f.state.history = [event()];
    f.d.fault.remove = true;
    let activeRead = true;
    const result = await f.refund.submit(input, current, () => activeRead, current);
    if (!result.ok || !result.data.receipt) throw Error('Expected exact known receipt');
    activeRead = false;
    f.d.fault.remove = false;
    expect(await f.refund.cleanupKnown(paymentId, result.data.receipt, current)).toBe(true);
    expect(f.state.posts).toHaveLength(1);
  });

  it('keeps a terminal event with an unrenderable offset timestamp unresolved', async () => {
    const f = fixture();
    f.d.values.set(operationKey, originalRaw);
    f.state.history = [{ ...event(), ts: '2026-10-10T09:42:00+24:00' }];
    expect(await f.refund.checkOriginal(paymentId, current)).toMatchObject({ ok: true, data: { receipt: null } });
    expect(f.d.values.get(operationKey)).toBe(originalRaw);
  });

  for (const status of [200, 400, 500])
    it(`keeps the dispatched original after aggregate ${status} with no matching terminal`, async () => {
      const f = fixture();
      f.state.postStatus = status;
      f.state.payment.refundedAmount = '25';
      expect(await f.refund.submit(input, current, current)).toMatchObject({ ok: true, data: { receipt: null } });
      expect(f.d.values.get(operationKey)).toBe(originalRaw);
      expect(f.state.posts).toEqual([input]);
      expect(await f.create().submit({ ...input, refundId: 'another-original' }, current, current)).toMatchObject({ ok: false });
      expect(f.state.posts).toHaveLength(1);
    });
  for (const name of ['refunded', 'refund.reversed'])
    it(`cleans only exact ${name} for the protected original payment`, async () => {
      const f = fixture();
      f.d.values.set(operationKey, originalRaw);
      f.state.history = [event(name)];
      expect(await f.refund.checkOriginal(paymentId, current)).toMatchObject({
        ok: true,
        data: { receipt: { kind: name === 'refunded' ? 'refunded' : 'reversed', refundId }, cleanupPending: false },
      });
      expect(f.d.values.has(operationKey)).toBe(false);
      expect(f.state.posts).toHaveLength(0);
    });
  for (const history of [
    [event('refund.posted')],
    [event('rail.refund')],
    [event('refunded', 'another-original')],
    [event('refunded', refundId, 25)],
    [event(), event('refund.reversed')],
    [],
  ])
    it(`retains an original for nonterminal, malformed or conflicting history ${JSON.stringify(history).slice(0, 70)}`, async () => {
      const f = fixture();
      f.d.values.set(operationKey, originalRaw);
      f.state.history = history;
      expect(await f.refund.checkOriginal(paymentId, current)).toMatchObject({ ok: true, data: { receipt: null } });
      expect(f.d.values.get(operationKey)).toBe(originalRaw);
    });
  it('keeps missing originals unresolved after the oldest-first 200-event cap', async () => {
    const f = fixture();
    f.d.values.set(operationKey, originalRaw);
    f.state.history = Array.from({ length: 200 }, (_, i) => ({
      ...event('refund.posted', 'other-original'),
      id: `${String(i).padStart(8, '0')}-5555-4555-8555-555555555555`,
    }));
    expect(await f.refund.checkOriginal(paymentId, current)).toMatchObject({ ok: true, data: { receipt: null, count: 200 } });
    expect(f.d.values.get(operationKey)).toBe(originalRaw);
  });
  for (const mismatch of ['id', 'merchantId'] as const)
    it(`rejects wrong payment ${mismatch} before original proof`, async () => {
      const f = fixture();
      f.d.values.set(operationKey, originalRaw);
      f.state.history = [event()];
      f.state.payment[mismatch] = '66666666-6666-4666-8666-666666666666';
      expect(await f.refund.checkOriginal(paymentId, current)).toMatchObject({ ok: false, code: 'pay.refund_payment_mismatch' });
      expect(f.d.values.get(operationKey)).toBe(originalRaw);
      expect(f.state.gets).not.toContain('payment.history');
    });
  for (const name of ['refunded', 'refund.reversed'])
    it(`keeps immutable ${name} proof and retries only local cleanup`, async () => {
      const f = fixture();
      f.d.values.set(operationKey, originalRaw);
      f.state.history = [event(name)];
      f.d.fault.remove = true;
      const first = await f.refund.checkOriginal(paymentId, current);
      if (!first.ok || !first.data.receipt) throw Error('Expected exact receipt');
      const proof = first.data.receipt;
      const gets = f.state.gets.length;
      f.state.history = [];
      expect(await f.refund.checkOriginal(paymentId, current)).toMatchObject({ ok: true, data: { receipt: proof, cleanupPending: true } });
      expect(f.state.gets).toHaveLength(gets);
      f.d.fault.remove = false;
      expect(await f.refund.cleanupKnown(paymentId, proof, current)).toBe(true);
      expect(f.state.posts).toHaveLength(0);
      expect(f.d.values.size).toBe(0);
    });
});

describe('Original storage and asynchronous admission', () => {
  it('a current empty restoration remains readable while another retired preflight owns admission', async () => {
    const f = fixture();
    let release!: () => void;
    f.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reviewCurrent = true;
    const pending = f.refund.submit(input, () => reviewCurrent, current);
    while (!f.state.gets.includes('merchant.me')) await new Promise((resolve) => setTimeout(resolve, 0));
    reviewCurrent = false;
    expect(await f.create().restore(paymentId, current)).toMatchObject({ ok: true });
    release();
    await pending;
    expect(f.state.posts).toHaveLength(0);
    expect(f.d.values.size).toBe(0);
  });

  for (const fault of ['read', 'write', 'silentWrite'] as const)
    it(`dispatches zero after ${fault} storage failure`, async () => {
      const f = fixture();
      f.d.fault[fault] = true;
      expect(await f.refund.submit(input, current, current)).toMatchObject({ ok: false, code: 'pay.refund_recovery_unavailable' });
      expect(f.state.posts).toHaveLength(0);
    });
  for (const raw of ['pending', 'uncertain', '{broken', JSON.stringify({ status: 'uncertain', amount: '25' })])
    it(`preserves legacy/corrupt record ${raw}`, async () => {
      const f = fixture();
      f.d.values.set(operationKey, raw);
      expect(await f.refund.submit(input, current, current)).toMatchObject({ ok: false });
      expect(f.d.values.get(operationKey)).toBe(raw);
      expect(f.state.posts).toHaveLength(0);
      await f.refund.checkOriginal(paymentId, current);
      expect(f.d.values.get(operationKey)).toBe(raw);
    });
  it('preserves conflicting durable and legacy originals without reconstruction', async () => {
    const f = fixture();
    f.d.values.set(operationKey, originalRaw);
    const other = JSON.stringify({ status: 'uncertain', reference: 'another-original' });
    f.d.legacy.set(operationKey, other);
    expect(await f.refund.submit(input, current, current)).toMatchObject({ ok: false });
    expect(f.state.posts).toHaveLength(0);
    expect([f.d.values.get(operationKey), f.d.legacy.get(operationKey)]).toEqual([originalRaw, other]);
  });
  it('retires held preflight before dispatch while an opposing current review works', async () => {
    const f = fixture();
    let release!: () => void;
    f.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reviewCurrent = true;
    const pending = f.refund.submit(input, () => reviewCurrent, current);
    await Promise.resolve();
    await Promise.resolve();
    reviewCurrent = false;
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
    expect(f.d.values.size).toBe(0);
    expect(f.state.posts).toHaveLength(0);
    f.state.hold = null;
    expect(await f.refund.submit(input, current, current)).toMatchObject({ ok: true });
    expect(f.state.posts).toHaveLength(1);
  });
  it('immediate API identity replacement refuses retained reads and dispatch before rerender', async () => {
    const f = fixture();
    f.state.current = false;
    expect(await f.refund.readPayment(paymentId, current)).toMatchObject({ ok: false, reason: 'aborted' });
    expect(await f.refund.submit(input, current, current)).toMatchObject({ ok: false, reason: 'aborted' });
    expect(f.state.gets).toEqual([]);
    expect(f.state.posts).toEqual([]);
  });
  it('holds the original native key lease through history proof and blocks another independent caller', async () => {
    const f = fixture();
    f.d.values.set(operationKey, originalRaw);
    f.state.history = [event()];
    let release!: () => void;
    f.state.holdHistory = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.refund.checkOriginal(paymentId, current);
    while (!f.state.gets.includes('payment.history')) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.create().submit({ ...input, refundId: 'replacement' }, current, current)).toMatchObject({ ok: false });
    expect(f.state.posts).toEqual([]);
    release();
    expect(await pending).toMatchObject({ ok: true, data: { receipt: { refundId } } });
  });
  it('a late exact history reply cannot clear a replacement raw original', async () => {
    const f = fixture();
    f.d.values.set(operationKey, originalRaw);
    f.state.history = [event()];
    let release!: () => void;
    f.state.holdHistory = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.refund.checkOriginal(paymentId, current);
    while (!f.state.gets.includes('payment.history')) await new Promise((resolve) => setTimeout(resolve, 0));
    const replacement = JSON.stringify({ status: 'uncertain', reference: 'replacement-original' });
    f.d.values.set(operationKey, replacement);
    release();
    expect(await pending).toMatchObject({ ok: true, data: { cleanupPending: true } });
    expect(f.d.values.get(operationKey)).toBe(replacement);
    const receipt = f.refund.inspect(paymentId, current).known!;
    expect(await f.refund.cleanupKnown(paymentId, receipt, current)).toBe(false);
    expect(f.d.values.get(operationKey)).toBe(replacement);
  });
  it('late history after identity replacement publishes no known proof or cleanup', async () => {
    const f = fixture();
    f.d.values.set(operationKey, originalRaw);
    f.state.history = [event()];
    let release!: () => void;
    f.state.holdHistory = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.refund.checkOriginal(paymentId, current);
    while (!f.state.gets.includes('payment.history')) await new Promise((resolve) => setTimeout(resolve, 0));
    f.state.current = false;
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
    expect(f.d.values.get(operationKey)).toBe(originalRaw);
    expect(f.refund.inspect(paymentId, current).known).toBe(null);
  });
  it('all authored refund recovery copy is complete in EN/ES/FR', () => {
    for (const locale of ['en', 'es', 'fr'] as const) expect(refundCopy.coverage(locale).missing).toEqual([]);
  });
});

describe('Refund failure wording', () => {
  const base = { busy: false, referenceHeld: false };
  it('never says the refund did not go through once a reference is held', () => {
    for (const code of [undefined, 'network', 'pay.read_failed', 'unauthorized'])
      expect(refundFailureKey({ ...base, code, referenceHeld: true })).toBe('notConfirmed');
    expect(refundCopy.t('notConfirmed')).toBe('We couldn’t confirm this refund yet. Nothing new will be sent. Check again.');
    expect(refundCopy.t('notConfirmed')).not.toMatch(/didn’t go through/);
  });
  it('says the read failed only when no refund was dispatched', () => {
    expect(refundFailureKey({ ...base, code: undefined })).toBe('readFailed');
    expect(refundFailureKey({ ...base, code: 'pay.some_other' })).toBe('readFailed');
  });
  for (const [code, key] of [
    ['pay.business_permission_missing', 'permissionMissing'],
    ['pay.business_authority_missing', 'permissionMissing'],
    ['pay.business_merchant_inactive', 'merchantInactive'],
    ['pay.business_merchant_mismatch', 'merchantInactive'],
    ['pay.refund_amount_invalid', 'invalidAmount'],
    ['pay.refund_input_invalid', 'invalidAmount'],
    ['pay.refund_context_changed', 'contextChanged'],
    ['pay.refund_recovery_unavailable', 'unavailableBody'],
  ] as const)
    for (const referenceHeld of [false, true])
      it(`maps ${code} to its own message (reference held: ${referenceHeld})`, () => {
        expect(refundFailureKey({ ...base, code, referenceHeld })).toBe(key);
      });
  it('another tab checking wins over every code', () => {
    expect(refundFailureKey({ busy: true, referenceHeld: true, code: 'pay.refund_amount_invalid' })).toBe('busy');
  });
  it('states the oldest-first history window and only claims a cut-off at the cap', () => {
    expect(HISTORY_WINDOW).toBe(200);
    expect(refundCopy.t('historyWindow', { count: 200 })).toContain('first 200 recorded updates (oldest first)');
    expect(refundCopy.t('historyAll', { count: 12 })).toBe('We checked all 12 recorded updates on this payment.');
  });
});
