import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceName,
} from '@intafaced/contracts';
import postgres from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import {
  MemoryLedger,
  formatAmount,
  ledgerPostWire,
  parseAmount,
  recipes,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import { LEDGER_POST_RECIPE, POST_RECIPE_NAMES } from '@intafaced/ledger-client/post-recipe';
import { LEDGER_POST_ALLOWLIST, grantFor, LEDGER_DOOR_CALLERS } from '@intafaced/ledger-client/gate';
import { registerS2sHttp } from './s2s-http.js';
import { LedgerService } from './service.js';

/**
 * `/trpc/postRecipe`: a service names a recipe and its inputs, and the ledger runs the recipe from ledger-client itself.
 * Signed with real S2S v3 keys (`keypair` mode, body bound), over an in-memory book. Its Postgres twin
 * (`post-recipe-door.pg.test.ts`) proves the freeze, the conflict refusal and the single booking on the real engine.
 */

const SHARED = 'ledger-shared-internal-secret-32chars!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WALLET = '0x00000000000000000000000000000000000000aa';
const PAY = `0x${'ab'.repeat(32)}`;
const PURCHASE = {
  course: 'perps-101',
  userId: USER,
  n: '1',
  assetId: 'USDC',
  amount: '2.5',
  to: { kind: 'treasury-wallet', walletId: WALLET },
  paymentId: PAY,
} as const;
const REFUND = { ...PURCHASE, to: undefined, from: PURCHASE.to, paymentId: `0x${'cd'.repeat(32)}` };
const refundInput = () => {
  const { to: _to, ...rest } = REFUND;
  return rest;
};

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

/**
 * The real `LedgerService`, every door and check of it, with its posts and the reads these tests make answered by an
 * in-memory book. Its Postgres client is never connected: a call that reached it would fail the test.
 */
class BookLedger extends LedgerService {
  constructor(
    private readonly book: MemoryLedger,
    private readonly posts: string[],
  ) {
    super(postgres('postgres://unused@127.0.0.1:1/unused_test', { max: 1 }), new MemoryEventBus('post-recipe-door'));
  }
  override async post(request: PostRequest): Promise<LedgerTx> {
    this.posts.push(request.idempotencyKey);
    return this.book.post(request);
  }
  override async getTxByKey(key: string): Promise<LedgerTx | null> {
    return this.book.getTxByKey(key);
  }
}

async function mount(options: { doorCallers?: Record<string, readonly string[]>; ledger?: MemoryLedger } = {}) {
  const book = options.ledger ?? new MemoryLedger({ idempotencyConflict: 'refuse' });
  const posts: string[] = [];
  const service = new BookLedger(book, posts);
  const callers: ServiceName[] = ['svc-academy', 'svc-agents', 'svc-ops', 'svc-bank'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signers = Object.fromEntries(
    keys.map((k) => [k.svc, createServiceSigner({ service: k.svc, kid: `${k.svc}.a`, privateKey: k.privateKey, keyring })]),
  );
  const app = Fastify({ logger: false });
  registerS2sHttp(app, service, SHARED, {
    bodyBind: 'require',
    s2s: { verifier: createServiceVerifier({ self: 'svc-ledger', keyring, bootSecond: 0 }), mode: 'keypair' },
    ...(options.doorCallers ? { doorCallers: options.doorCallers } : {}),
  });
  await app.ready();
  const send = (path: string, body: unknown, as: ServiceName = 'svc-academy', audience: ServiceName = 'svc-ledger') => {
    const payload = JSON.stringify(body);
    const headers = signers[as]!.headers({
      audience,
      method: 'POST',
      url: new URL(`http://svc-ledger.internal${path}`),
      body: payload,
      context: { contentType: 'application/json' },
    });
    return app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers }, payload });
  };
  const postRecipe = (body: unknown, as?: ServiceName, audience?: ServiceName) => send(LEDGER_POST_RECIPE.path, body, as, audience);
  return { app, book, posts, send, postRecipe };
}

describe('postRecipe: who may call it', () => {
  it('names exactly the services granted a recipe on the door: svc-academy and svc-agents', () => {
    const granted = Object.entries(LEDGER_POST_ALLOWLIST)
      .filter(([, grants]) => POST_RECIPE_NAMES.some((name) => Object.hasOwn(grants, name)))
      .map(([service]) => service)
      .sort();
    // svc-trade holds a `feeCharge` grant (module trade) for `/trpc/post` only: it is not a caller of this door.
    expect([...LEDGER_POST_RECIPE.access.callers].sort()).toEqual(granted.filter((s) => s !== 'svc-trade'));
    expect(LEDGER_DOOR_CALLERS.postRecipe).toEqual(['svc-academy', 'svc-agents']);
    expect(POST_RECIPE_NAMES).toEqual(['academyPurchase', 'academyPurchaseRefund', 'feeCharge', 'chargeEarn', 'chargeCollect']);
    for (const name of ['academyPurchase', 'academyPurchaseRefund'] as const) expect(grantFor('svc-academy', name)?.module).toBe('academy');
    for (const name of ['feeCharge', 'chargeEarn', 'chargeCollect'] as const) {
      expect(grantFor('svc-agents', name)?.module).toBe('agents');
      expect(grantFor('svc-academy', name)).toBeUndefined();
    }
  });

  it('refuses an unsigned call (401), and books nothing', async () => {
    const { app, posts } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: LEDGER_POST_RECIPE.path,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ recipe: 'academyPurchase', input: PURCHASE }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ledger.unauthenticated');
    expect(posts).toEqual([]);
  });

  it('refuses a call signed for another audience (401), and books nothing', async () => {
    const { postRecipe, posts } = await mount();
    const res = await postRecipe({ recipe: 'academyPurchase', input: PURCHASE }, 'svc-academy', 'svc-pay');
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ledger.unauthenticated');
    expect(posts).toEqual([]);
  });

  it('refuses the shared secret in keypair mode (401), and books nothing', async () => {
    const { app, posts } = await mount();
    const payload = JSON.stringify({ recipe: 'academyPurchase', input: PURCHASE });
    const res = await app.inject({
      method: 'POST',
      url: LEDGER_POST_RECIPE.path,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-academy', SHARED, payload) },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(posts).toEqual([]);
  });

  it('refuses a proven service the door does not name (403), even one that may post other recipes', async () => {
    const { postRecipe, posts } = await mount();
    const res = await postRecipe({ recipe: 'academyPurchase', input: PURCHASE }, 'svc-bank');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(posts).toEqual([]);
  });

  it('refuses a recipe not granted to this caller (403) before reading its inputs, when the door lets the caller in', async () => {
    const { postRecipe, posts } = await mount({ doorCallers: { postRecipe: ['svc-academy', 'svc-ops'] } });
    const res = await postRecipe({ recipe: 'academyPurchase', input: { garbage: true } }, 'svc-ops');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ledger.caller_forbidden', message: 'Caller svc-ops may not post recipe academyPurchase.' });
    expect(posts).toEqual([]);
  });
});

describe('postRecipe: what it refuses from the body (400, nothing read or booked)', () => {
  it('refuses a recipe it does not post: unknown, missing, or a registry recipe not on the door', async () => {
    const { postRecipe, posts } = await mount();
    for (const body of [
      { recipe: 'academyPurchaseX', input: PURCHASE },
      { input: PURCHASE },
      { recipe: 'deposit', input: { userId: USER, assetId: 'USDT', amount: '10', rail: 'test', railRef: 'x' } },
      { recipe: 'constructor', input: PURCHASE },
      { recipe: '__proto__', input: PURCHASE },
      null,
      [],
    ]) {
      const res = await postRecipe(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code, JSON.stringify(body)).toBe('ledger.recipe_unknown');
    }
    expect(posts).toEqual([]);
  });

  const badFields: [string, Record<string, unknown>][] = [
    ['course upper case', { course: 'Perps-101' }],
    ['course missing', { course: undefined }],
    ['userId not a uuid', { userId: 'fees:academy' }],
    ['userId upper case', { userId: USER.toUpperCase() }],
    ['n zero', { n: '0' }],
    ['n a number', { n: 1 }],
    ['n leading zero', { n: '01' }],
    ['n negative', { n: '-1' }],
    ['assetId blank', { assetId: '' }],
    ['assetId spaced', { assetId: ' USDC' }],
    ['amount a number', { amount: 2.5 }],
    ['amount negative', { amount: '-2.5' }],
    ['amount exponent', { amount: '2.5e3' }],
    ['amount nineteen places', { amount: '0.0000000000000000001' }],
    ['amount spaced', { amount: ' 2.5' }],
    ['amount zero (the recipe refuses it)', { amount: '0' }],
    ['amount beyond the book (the money parser refuses it)', { amount: '9'.repeat(60) }],
    ['to of another kind', { to: { kind: 'user', userId: USER } }],
    ['to with an upper-case wallet', { to: { kind: 'treasury-wallet', walletId: WALLET.toUpperCase() } }],
    ['to with an extra field', { to: { kind: 'treasury-wallet', walletId: WALLET, ownerType: 'user' } }],
    ['paymentId short', { paymentId: '0xabc' }],
    ['paymentId upper case', { paymentId: PAY.toUpperCase() }],
    ['an extra field', { idempotencyKey: 'mine' }],
    ['entries smuggled in', { entries: [] }],
  ];

  it.each(badFields)('refuses the purchase with %s', async (_what, patch) => {
    const { postRecipe, posts } = await mount();
    const res = await postRecipe({ recipe: 'academyPurchase', input: { ...PURCHASE, ...patch } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ledger.recipe_input_invalid');
    expect(posts).toEqual([]);
  });

  it('refuses a refund sent with the purchase\'s "to", and a body with a key, entries or module of its own', async () => {
    const { postRecipe, posts } = await mount();
    for (const body of [
      { recipe: 'academyPurchaseRefund', input: PURCHASE },
      { recipe: 'academyPurchase', input: PURCHASE, idempotencyKey: 'mine' },
      { recipe: 'academyPurchase', input: PURCHASE, module: 'bank' },
      { recipe: 'academyPurchase', input: PURCHASE, entries: [] },
      { recipe: 'academyPurchase' },
    ]) {
      const res = await postRecipe(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code).toBe('ledger.recipe_input_invalid');
    }
    expect(posts).toEqual([]);
  });
});

const BUSINESS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EARN = {
  module: 'agents',
  saleId: `${USER}.w1`,
  userId: BUSINESS,
  memberUserId: USER,
  assetId: 'USDC',
  price: { perUnit: '0.25' },
  units: '1',
};
const COLLECT = {
  module: 'agents',
  userId: BUSINESS,
  to: { kind: 'partner-reserve', partnerId: 'reserve-a' },
  paymentId: 'pay_1',
  assetId: 'USDC',
  amount: '0.25',
};
const FEE = {
  chargeId: `agent.usage:${USER}:w1`,
  userId: USER,
  module: 'agents',
  mode: 'asset',
  assetId: 'USDC',
  amount: '0.25',
  reason: 'agents.usage.metered',
};

describe("postRecipe: svc-agents' usage charge", () => {
  it('books the earn and then the collect, each the post the registry recipe builds, under its business key', async () => {
    const { postRecipe, book } = await mount();
    const earned = await postRecipe({ recipe: 'chargeEarn', input: EARN }, 'svc-agents');
    expect(earned.statusCode, earned.body).toBe(200);
    const built = recipes.chargeEarn({ ...EARN, price: { perUnit: parseAmount('0.25') }, units: 1n });
    expect(earned.json()).toMatchObject({ idempotencyKey: built.idempotencyKey, module: 'agents', reason: 'charge.earned' });
    expect((await book.getTxByKey(built.idempotencyKey))?.meta).toEqual(built.meta);
    const collected = await postRecipe({ recipe: 'chargeCollect', input: COLLECT }, 'svc-agents');
    expect(collected.statusCode, collected.body).toBe(200);
    expect(collected.json().idempotencyKey).toBe('charge:collected:partner-reserve:reserve-a:USDC:pay_1');
    const fees = await book.balance({ ownerType: 'house', ownerId: 'fees:agents', assetId: 'USDC', kind: 'available' });
    expect(formatAmount(fees.amount)).toBe('0.25');
    const owed = await book.balance({
      ownerType: 'treasury',
      ownerId: `charge-receivable:agents.${BUSINESS}`,
      assetId: 'USDC',
      kind: 'available',
    });
    expect(formatAmount(owed.amount)).toBe('0');
  });

  it('a collect above what is owed is refused by the ledger (400 insufficient funds), nothing booked', async () => {
    const { postRecipe, posts } = await mount();
    const res = await postRecipe({ recipe: 'chargeCollect', input: COLLECT }, 'svc-agents');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ledger.insufficient_funds');
    expect(posts).toEqual(['charge:collected:partner-reserve:reserve-a:USDC:pay_1']);
  });

  it('the fee charge reaches the ledger as the registry recipe builds it', async () => {
    const { postRecipe, posts } = await mount();
    const res = await postRecipe({ recipe: 'feeCharge', input: FEE }, 'svc-agents');
    // Custodial: refused with the custody layer off, or by the empty balance with it on; either way after the door built it.
    expect([400, 412]).toContain(res.statusCode);
    expect(posts).toEqual([`fee:agents:agent.usage:${USER}:w1`]);
  });

  it("refuses svc-agents' recipes from svc-academy, and svc-academy's from svc-agents (403), reading nothing", async () => {
    const { postRecipe, posts } = await mount();
    const a = await postRecipe({ recipe: 'chargeEarn', input: EARN }, 'svc-academy');
    expect(a.statusCode).toBe(403);
    const b = await postRecipe({ recipe: 'academyPurchase', input: PURCHASE }, 'svc-agents');
    expect(b.statusCode).toBe(403);
    expect(posts).toEqual([]);
  });

  it('refuses a module other than its grant (403), and inputs the recipe refuses (400), booking nothing', async () => {
    const { postRecipe, posts } = await mount();
    const other = await postRecipe({ recipe: 'chargeEarn', input: { ...EARN, module: 'academy' } }, 'svc-agents');
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('ledger.caller_forbidden');
    for (const input of [
      { ...EARN, price: { perUnit: '0' } },
      { ...EARN, price: { perUnit: '99999999999999999999' }, units: '9999999999999999999' },
      { ...COLLECT, amount: '0' },
      { ...FEE, amount: '0' },
    ]) {
      const recipe = 'price' in input ? 'chargeEarn' : 'chargeId' in input ? 'feeCharge' : 'chargeCollect';
      const res = await postRecipe({ recipe, input }, 'svc-agents');
      expect(res.statusCode, JSON.stringify(input)).toBe(400);
      expect(res.json().code).toBe('ledger.recipe_input_invalid');
    }
    expect(posts).toEqual([]);
  });
});

describe('postRecipe: what it books', () => {
  it('books the purchase under its business key and answers the booked entries as decimal strings', async () => {
    const { postRecipe, book } = await mount();
    const res = await postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    expect(res.statusCode).toBe(200);
    const reply = LEDGER_POST_RECIPE.output.parse(res.json());
    expect(reply).toMatchObject({
      idempotencyKey: `academy:purchase:perps-101:${USER}:1`,
      module: 'academy',
      reason: 'academy.purchase.posted',
    });
    expect(reply.entries.map((e) => [e.direction, e.amount])).toEqual([
      ['debit', '2.5'],
      ['credit', '2.5'],
    ]);
    const tx = await book.getTxByKey(reply.idempotencyKey);
    expect(tx?.id).toBe(reply.txId);
  });

  it('a retry of the same call (the first answer was lost) returns the same transaction and books nothing twice', async () => {
    const { postRecipe, book, posts } = await mount();
    const first = (await postRecipe({ recipe: 'academyPurchase', input: PURCHASE })).json();
    const again = await postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ txId: first.txId, hash: first.hash });
    expect(posts).toEqual([first.idempotencyKey, first.idempotencyKey]);
    const balance = await book.balance({ ownerType: 'house', ownerId: 'fees:academy', assetId: 'USDC', kind: 'available' });
    expect(formatAmount(balance.amount)).toBe('2.5');
  });

  it('the same key with a different body is refused (409), and the first booking stands', async () => {
    const { postRecipe, book } = await mount();
    const first = (await postRecipe({ recipe: 'academyPurchase', input: PURCHASE })).json();
    const other = await postRecipe({ recipe: 'academyPurchase', input: { ...PURCHASE, amount: '3' } });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('ledger.idempotency_conflict');
    expect((await book.getTxByKey(first.idempotencyKey))?.id).toBe(first.txId);
    const balance = await book.balance({ ownerType: 'house', ownerId: 'fees:academy', assetId: 'USDC', kind: 'available' });
    expect(formatAmount(balance.amount)).toBe('2.5');
  });

  it('a refund above the revenue on the book is refused by the ledger (400 insufficient funds), nothing booked', async () => {
    const { postRecipe, book } = await mount();
    const res = await postRecipe({ recipe: 'academyPurchaseRefund', input: refundInput() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ledger.insufficient_funds');
    expect(await book.getTxByKey(`academy:refund:perps-101:${USER}:1`)).toBeNull();
  });

  it('books the refund after the purchase: revenue back to zero, the wallet back to zero', async () => {
    const { postRecipe, book } = await mount();
    expect((await postRecipe({ recipe: 'academyPurchase', input: PURCHASE })).statusCode).toBe(200);
    const res = await postRecipe({ recipe: 'academyPurchaseRefund', input: refundInput() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ idempotencyKey: `academy:refund:perps-101:${USER}:1`, reason: 'academy.purchase.refunded' });
    const fees = await book.balance({ ownerType: 'house', ownerId: 'fees:academy', assetId: 'USDC', kind: 'available' });
    expect(fees.amount).toBe(0n);
  });
});

/** What a book holds, with the per-book ids taken out: the same movements compare equal across books. */
function shape(tx: LedgerTx | null) {
  if (!tx) return null;
  return {
    idempotencyKey: tx.idempotencyKey,
    module: tx.module,
    reason: tx.reason,
    meta: tx.meta,
    entries: tx.entries.map((e) => ({ assetId: e.assetId, direction: e.direction, amount: e.amount, balanceAfter: e.balanceAfter })),
  };
}

const hex = (len: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${len}}$`));
const validCall = fc.record({
  course: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,63}$/),
  userId: fc.uuid({ version: 4 }).map((u) => u.toLowerCase()),
  n: fc.bigInt({ min: 1n, max: 10n ** 12n }),
  assetId: fc.constantFrom('USDC', 'USDT', 'IFC', 'ETH'),
  amount: fc.bigInt({ min: 1n, max: 10n ** 30n }),
  place: fc.oneof(
    { arbitrary: hex(40).map((h) => ({ kind: 'treasury-wallet' as const, walletId: `0x${h}` })), weight: 4 },
    hex(40).map((h) => ({ kind: 'treasury-wallet' as const, walletId: `0x${h}` })),
    fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,20}$/).map((id) => ({ kind: 'venue-builder-account' as const, venueId: id })),
    fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,20}$/).map((id) => ({ kind: 'partner-reserve' as const, partnerId: id })),
  ),
  pay: hex(64).map((h) => `0x${h}`),
  refundPay: hex(64).map((h) => `0x${h}`),
});

describe('postRecipe books exactly what post(recipes[name](input)) books (property, fixed seed)', () => {
  it('for random valid purchases and their refunds, the two doors leave the same book', async () => {
    let booked = 0;
    await fc.assert(
      fc.asyncProperty(validCall, async (c) => {
        const viaRecipe = await mount();
        const viaPost = await mount();
        const purchase = {
          course: c.course,
          userId: c.userId,
          n: c.n,
          assetId: c.assetId,
          amount: c.amount,
          to: c.place,
          paymentId: c.pay,
        };
        const refund = { ...purchase, to: undefined, from: c.place, paymentId: c.refundPay };
        delete (refund as { to?: unknown }).to;
        const wire = (input: Record<string, unknown>) => ({ ...input, n: String(input.n), amount: formatAmount(input.amount as bigint) });

        const a1 = await viaRecipe.postRecipe({ recipe: 'academyPurchase', input: wire(purchase) });
        const a2 = await viaRecipe.postRecipe({ recipe: 'academyPurchaseRefund', input: wire(refund) });
        const p1 = recipes.academyPurchase(purchase);
        const p2 = recipes.academyPurchaseRefund(refund as Parameters<typeof recipes.academyPurchaseRefund>[0]);
        const b1 = await viaPost.send('/trpc/post', ledgerPostWire(p1));
        const b2 = await viaPost.send('/trpc/post', ledgerPostWire(p2));
        // The same answer on both doors, refusals included (a purchase into a partner reserve is refused by the book on
        // both: a reserve never shows less than nothing of ours).
        expect([a1.statusCode, a2.statusCode]).toEqual([b1.statusCode, b2.statusCode]);
        expect([a1.json().code, a2.json().code]).toEqual([b1.json().code, b2.json().code]);
        for (const key of [p1.idempotencyKey, p2.idempotencyKey]) {
          expect(shape(await viaRecipe.book.getTxByKey(key))).toEqual(shape(await viaPost.book.getTxByKey(key)));
        }
        if (a1.statusCode === 200) {
          booked += 1;
          expect(a1.json().idempotencyKey).toBe(p1.idempotencyKey);
          expect(a2.statusCode).toBe(200);
          expect(a2.json().idempotencyKey).toBe(p2.idempotencyKey);
          // Same reply on both doors, ids aside.
          const strip = (r: { entries: { amount: string; direction: string; balanceAfter: string; assetId: string }[] }) =>
            r.entries.map((e) => [e.assetId, e.direction, e.amount, e.balanceAfter]);
          expect(strip(a1.json())).toEqual(strip(b1.json()));
          expect(strip(a2.json())).toEqual(strip(b2.json()));
          expect(parseAmount(a1.json().entries[0].amount)).toBe(c.amount);
        }
        await viaRecipe.app.close();
        await viaPost.app.close();
      }),
      { seed: 3343, numRuns: 60 },
    );
    // Most runs book (a treasury wallet may go below zero): the property is not only refusals agreeing.
    expect(booked).toBeGreaterThan(20);
  });
});
