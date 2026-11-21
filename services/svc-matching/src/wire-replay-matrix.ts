import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';

/**
 * The request matrix of the wire replay (`wire-replay.test.ts`): every door, in the order the replay sends them, and
 * the inputs each gets. Kept apart from the test so `crates/svc-matching/scripts/record-door.mjs` can write the same
 * requests for the Rust door's replay. The callers and the two set-ups stay in the test.
 */

export const NOW = new Date('2026-11-19T00:00:00.000Z');
export const MARKET = 'BTC-USDT';
const UNKNOWN = 'NOPE-USD';
const SPREAD = 'BTC-CAL-MAR-JUN';
export const OPERATOR = '11111111-1111-4111-8111-111111111111';
export const CONFIRM = '44444444-4444-4444-8444-444444444444';
const ORDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const RESTING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SPREAD_ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export type Action = 'PLACE' | 'PLACE_POST_ONLY' | 'AMEND';

export function proof(marketId: string, action: Action) {
  const at = NOW.toISOString();
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: 'test.rules.v1',
      instrumentId: marketId,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: at,
      observedAt: at,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY', 'AMEND'],
      transitionId: 'test.transition',
      evidenceRefs: ['test.evidence'],
    },
    action,
  );
}

// ── The doors, in the order they run ───────────────────────────────────────

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
/** One request a door gets: a name, the URL (path and query), and the body (undefined sends none). */
export type Input = readonly [name: string, url: string, body?: unknown];
export interface Door {
  /** The golden file this door's answers go in. */
  readonly file: string;
  readonly method: Method;
  readonly own: readonly Input[];
  /** Whether the door reads a JSON body, so it also gets the six generic bodies. */
  readonly body: boolean;
}

const submitBody = {
  orderId: ORDER,
  accountId: 'acct-1',
  type: 'limit',
  side: 'buy',
  qty: '1.5',
  price: '30000',
  tif: 'GTC',
  lifecycleProof: proof(MARKET, 'PLACE'),
};
const kill = { operatorId: OPERATOR, confirmOperatorId: CONFIRM, approvalId: 'appr-1', operationId: 'op-1' };
const killDoor = (file: string, url: string): Door => ({
  file,
  method: 'POST',
  body: true,
  own: [
    ['valid', url, kill],
    ['no-approval', url, { operatorId: OPERATOR, confirmOperatorId: CONFIRM }],
    ['not-operator', url, { ...kill, operatorId: 'someone-else' }],
    ['blank-operator', url, { ...kill, operatorId: '' }],
  ],
});
const founder = (door: string, marketId?: string) => ({
  ...(marketId === undefined ? {} : { marketId }),
  approvalId: 'appr-9',
  operationId: 'op-9',
  idempotencyKey: `wire-replay-${door}`,
});
const founderDoor = (file: string, url: string, market: boolean): Door => {
  const valid = founder(file, market ? MARKET : undefined);
  return {
    file,
    method: 'POST',
    body: true,
    own: [
      ['valid', url, valid],
      ['replay-same-key', url, valid],
      ['same-key-other-request', url, { ...valid, operationId: 'op-other' }],
      ['short-key', url, { ...valid, idempotencyKey: 'short' }],
      ['no-market', url, { approvalId: 'appr-8', operationId: 'op-8', idempotencyKey: `wire-replay-${file}-no-market` }],
    ],
  };
};
const limits = (path: string, extra: readonly Input[] = []): readonly Input[] => [
  ['limit-10', `${path}?limit=10`],
  ['no-limit', path],
  ['limit-0', `${path}?limit=0`],
  ['limit-501', `${path}?limit=501`],
  ['limit-word', `${path}?limit=ten`],
  ...extra,
];
const sections = (version: string) => ({
  participation: `${version} TEST participation.`,
  matching: `${version} TEST matching.`,
  cancellation: `${version} TEST cancellation.`,
  settlement: `${version} TEST settlement.`,
  liquidation: `${version} TEST liquidation.`,
  fees: `${version} TEST fees.`,
  market_data: `${version} TEST market data.`,
});
const draft = { version: 'TEST-v1', effectiveAt: '2026-11-20T00:00:00.000Z', sections: sections('TEST-v1') };
const spreadListing = {
  kind: 'calendar',
  legs: [
    { symbol: 'BTC-27MAR', side: 'sell', ratio: '1' },
    { symbol: 'BTC-26JUN', side: 'buy', ratio: '1' },
  ],
  tick: '0.5',
  lot: '0.001',
  ...kill,
};
const spreadOrder = {
  orderId: SPREAD_ORDER,
  accountId: 'mm',
  side: 'sell',
  qty: '2',
  price: '150',
  tif: 'GTC',
  anchorReference: '60000',
  lifecycleProof: proof(SPREAD, 'PLACE'),
};
const quoteSide = (orderId: string, price: string) => ({ orderId, type: 'limit', qty: '1', price, tif: 'GTC' });

export const DOORS: readonly Door[] = [
  { file: 'health', method: 'GET', body: false, own: [['valid', '/health']] },
  { file: 'markets', method: 'GET', body: false, own: [['valid', '/markets']] },
  {
    file: 'depth',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/depth`, [
      ['format-sbe', `/markets/${MARKET}/depth?limit=10&format=sbe`],
      ['format-l3', `/markets/${MARKET}/depth?limit=10&format=l3`],
      ['unknown-market', `/markets/${UNKNOWN}/depth?limit=10`],
    ]),
  },
  {
    file: 'depth-l3',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/depth/l3`, [['unknown-market', `/markets/${UNKNOWN}/depth/l3?limit=10`]]),
  },
  {
    file: 'depth-sbe',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/depth/sbe`, [['unknown-market', `/markets/${UNKNOWN}/depth/sbe?limit=10`]]),
  },
  {
    file: 'orders-submit',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/orders`, submitBody],
      ['market-mismatch', `/markets/${UNKNOWN}/orders`, submitBody],
      ['post-only-ioc', `/markets/${MARKET}/orders`, { ...submitBody, tif: 'IOC', postOnly: true }],
      ['post-only-wrong-proof', `/markets/${MARKET}/orders`, { ...submitBody, postOnly: true }],
      ['number-qty', `/markets/${MARKET}/orders`, { ...submitBody, qty: 1.5 }],
      ['too-precise', `/markets/${MARKET}/orders`, { ...submitBody, qty: '1.0000000000000000001' }],
      ['market-buy', `/markets/${MARKET}/orders`, { ...submitBody, type: 'market', price: null, tif: 'IOC' }],
    ],
  },
  {
    file: 'orders-list',
    method: 'GET',
    body: false,
    own: limits(`/markets/${MARKET}/orders`, [['unknown-market', `/markets/${UNKNOWN}/orders?limit=10`]]),
  },
  {
    file: 'orders-amend',
    method: 'PATCH',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/orders/${ORDER}`, { expectedVersion: 1, qty: '1', lifecycleProof: proof(MARKET, 'AMEND') }],
      ['nothing-changed', `/markets/${MARKET}/orders/${ORDER}`, { expectedVersion: 1, lifecycleProof: proof(MARKET, 'AMEND') }],
      ['place-proof', `/markets/${MARKET}/orders/${ORDER}`, { expectedVersion: 1, qty: '1', lifecycleProof: proof(MARKET, 'PLACE') }],
      [
        'unknown-order',
        `/markets/${MARKET}/orders/${SPREAD_ORDER}`,
        { expectedVersion: 1, qty: '1', lifecycleProof: proof(MARKET, 'AMEND') },
      ],
    ],
  },
  {
    file: 'mark',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/mark`, { mark: '30050' }],
      ['negative', `/markets/${MARKET}/mark`, { mark: '-1' }],
    ],
  },
  {
    file: 'positions-read',
    method: 'GET',
    body: false,
    own: [
      ['valid', `/markets/${MARKET}/positions/acct-1`],
      ['unknown-market', `/markets/${UNKNOWN}/positions/acct-1`],
      ['long-account', `/markets/${MARKET}/positions/${'a'.repeat(129)}`],
    ],
  },
  {
    file: 'positions-close',
    method: 'POST',
    body: true,
    own: [
      [
        'valid',
        `/markets/${MARKET}/positions/close`,
        { orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', accountId: 'acct-1', lifecycleProof: proof(MARKET, 'PLACE') },
      ],
      [
        'amend-proof',
        `/markets/${MARKET}/positions/close`,
        { orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', accountId: 'acct-1', lifecycleProof: proof(MARKET, 'AMEND') },
      ],
    ],
  },
  {
    file: 'mass-quote',
    method: 'POST',
    body: true,
    own: [
      [
        'valid',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: 'set-1',
          accountId: 'mm-2',
          bid: quoteSide('f1111111-1111-4111-8111-111111111111', '29000'),
          ask: quoteSide('f2222222-2222-4222-8222-222222222222', '31000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
      [
        'one-side-unflagged',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: 'set-2',
          accountId: 'mm-2',
          bid: quoteSide('f3333333-3333-4333-8333-333333333333', '29000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
      [
        'blank-set',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: '',
          accountId: 'mm-2',
          oneSided: true,
          bid: quoteSide('f4444444-4444-4444-8444-444444444444', '29000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
      [
        'mmp-blank',
        `/markets/${MARKET}/mass-quote`,
        {
          setId: 'set-3',
          accountId: 'mm-2',
          oneSided: true,
          mmp: true,
          mmpMaxQuote: '',
          bid: quoteSide('f5555555-5555-4555-8555-555555555555', '29000'),
          lifecycleProof: proof(MARKET, 'PLACE'),
        },
      ],
    ],
  },
  {
    file: 'orders-cancel',
    method: 'DELETE',
    body: false,
    own: [
      ['valid', `/markets/${MARKET}/orders/${ORDER}`],
      ['unknown-order', `/markets/${MARKET}/orders/${SPREAD_ORDER}`],
      ['unknown-market', `/markets/${UNKNOWN}/orders/${ORDER}`],
    ],
  },
  {
    file: 'mass-cancel',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/markets/${MARKET}/orders/mass-cancel`, { accountId: 'mm-2' }],
      ['one-side', `/markets/${MARKET}/orders/mass-cancel`, { accountId: 'mm', side: 'sell' }],
      ['session', `/markets/${MARKET}/orders/mass-cancel`, { accountId: 'mm', sessionId: 'sess-1' }],
    ],
  },
  {
    file: 'session-dead',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/session/dead', { sessionId: 'sess-1' }],
      ['blank', '/session/dead', { sessionId: '' }],
    ],
  },
  {
    file: 'reconcile',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/reconcile', { orders: [{ orderId: RESTING, marketId: MARKET, state: 'open', remaining: '2', funded: true }] }],
      ['unknown-order', '/reconcile', { orders: [{ orderId: 'ghost', marketId: MARKET, state: 'open', remaining: '1', funded: false }] }],
      ['none', '/reconcile', { orders: [] }],
    ],
  },
  { file: 'spreads', method: 'GET', body: false, own: [['valid', '/spreads']] },
  {
    file: 'spread-list',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/spreads/${SPREAD}/list`, spreadListing],
      ['blank-tick', `/spreads/${SPREAD}/list`, { ...spreadListing, tick: '' }],
      ['no-approval', `/spreads/${SPREAD}/list`, { ...spreadListing, approvalId: undefined, operationId: undefined }],
    ],
  },
  {
    file: 'spread-orders',
    method: 'POST',
    body: true,
    own: [
      ['valid', `/spreads/${SPREAD}/orders`, spreadOrder],
      [
        'no-anchor',
        `/spreads/${SPREAD}/orders`,
        { ...spreadOrder, orderId: 'dddddddd-dddd-4ddd-8ddd-000000000001', anchorReference: null },
      ],
      ['negative-price', `/spreads/${SPREAD}/orders`, { ...spreadOrder, orderId: 'dddddddd-dddd-4ddd-8ddd-000000000002', price: '-5' }],
      ['unlisted', `/spreads/NOPE-SPREAD/orders`, { ...spreadOrder, lifecycleProof: proof('NOPE-SPREAD', 'PLACE') }],
    ],
  },
  {
    file: 'spread-book',
    method: 'GET',
    body: false,
    own: limits(`/spreads/${SPREAD}/book`, [['unlisted', '/spreads/NOPE-SPREAD/book?limit=10']]),
  },
  { file: 'rulebook', method: 'GET', body: false, own: [['valid', '/rulebook']] },
  { file: 'rulebook-versions', method: 'GET', body: false, own: [['valid', '/rulebook/versions']] },
  {
    file: 'operator-rulebook-check',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/operator/rulebook/check', draft],
      ['section-unset', '/operator/rulebook/check', { ...draft, sections: { ...sections('TEST-v1'), fees: '' } }],
      ['no-version', '/operator/rulebook/check', { sections: sections('TEST-v1') }],
    ],
  },
  {
    file: 'operator-rulebook-publish',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/operator/rulebook/publish', { ...draft, approvalId: 'appr-r1', operationId: 'op-r1' }],
      ['same-again', '/operator/rulebook/publish', { ...draft, approvalId: 'appr-r2', operationId: 'op-r2' }],
      [
        'other-text',
        '/operator/rulebook/publish',
        { ...draft, sections: { ...sections('TEST-v1'), fees: 'TEST other fees.' }, approvalId: 'appr-r3', operationId: 'op-r3' },
      ],
    ],
  },
  {
    file: 'rulebook-after',
    method: 'GET',
    body: false,
    own: [
      ['valid', '/rulebook'],
      ['versions', '/rulebook/versions'],
    ],
  },
  { file: 'surveillance-cases', method: 'GET', body: false, own: limits('/surveillance/cases') },
  {
    file: 'surveillance-adjudicate',
    method: 'POST',
    body: true,
    own: [
      ['valid', '/surveillance/adjudicate', { reason: 'TEST reviewed' }],
      ['no-reason', '/surveillance/adjudicate', {}],
    ],
  },
  { file: 'surveillance-fine', method: 'POST', body: true, own: [['valid', '/surveillance/fine', { amount: '10' }]] },
  { file: 'operator-in-flight', method: 'GET', body: false, own: [['valid', '/operator/in-flight']] },
  killDoor('post-only', `/markets/${MARKET}/post-only`),
  killDoor('post-only-resume', `/markets/${MARKET}/post-only/resume`),
  killDoor('reduce-only', `/markets/${MARKET}/reduce-only`),
  killDoor('reduce-only-resume', `/markets/${MARKET}/reduce-only/resume`),
  killDoor('prelaunch', `/markets/ETH-USDT/prelaunch`),
  killDoor('open', `/markets/ETH-USDT/open`),
  killDoor('halt', `/markets/${MARKET}/halt`),
  killDoor('resume', `/markets/${MARKET}/resume`),
  founderDoor('operator-halt', '/operator/halt', true),
  founderDoor('operator-resume', '/operator/resume', true),
  killDoor('halt-all', '/halt-all'),
  killDoor('resume-all', '/resume-all'),
  founderDoor('operator-halt-all', '/operator/halt-all', false),
  founderDoor('operator-resume-all', '/operator/resume-all', false),
  killDoor('expire', `/markets/ETH-USDT/expire`),
  killDoor('delist', `/markets/ETH-USDT/delist`),
  {
    file: 'after',
    method: 'GET',
    body: false,
    own: [
      ['markets', '/markets'],
      ['spreads', '/spreads'],
      ['health', '/health'],
      ['depth', `/markets/${MARKET}/depth?limit=10`],
      ['in-flight', '/operator/in-flight'],
    ],
  },
];

/** A body door also gets: none; null; a wrong type; an empty object; its valid body plus a key; its valid body with every field null. */
export function inputs(door: Door): readonly Input[] {
  if (!door.body) return door.own;
  const first = door.own[0];
  if (first === undefined) return door.own;
  const [, url, valid] = first;
  const object: Record<string, unknown> = valid !== null && typeof valid === 'object' ? { ...valid } : {};
  return [
    ...door.own,
    ['absent', url, undefined],
    ['null', url, null],
    ['wrong-type', url, 7],
    ['empty', url, {}],
    ['extra-key', url, { ...object, extra: 1 }],
    ['all-null', url, Object.fromEntries(Object.keys(object).map((k) => [k, null]))],
  ];
}
