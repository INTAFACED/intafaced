// Records, from the TypeScript svc-matching in this checkout, what the Rust journal (`src/journal/`) is held to:
//
// - `tests/fixtures/journal-codec.golden.ndjson`: `encode` (`journal-codec.ts`) on records of every kind, each optional
//   field absent and set to each kind of JSON value, and records it refuses (each record held as the JSON value it is); and `decodeAll` (`journal-io.ts`) on
//   bodies with torn, broken and blank lines. Every record goes in as the text `JSON.parse` reads off disk.
//
// Run from the repository root:
//   TZ=UTC node --import tsx crates/svc-matching/scripts/record-journal.mjs          writes the file
//   TZ=UTC node --import tsx crates/svc-matching/scripts/record-journal.mjs --check  fails when it is stale
//
// It reads the TypeScript service and never writes there. It stops being runnable when the TypeScript service is
// deleted, and from then on what it wrote is the reference.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-matching/src/`;
const NAME = 'record-journal';
if (!existsSync(SVC)) {
  console.error(`${NAME}: services/svc-matching no longer exists; nothing to record from. The file it wrote is the reference now.`);
  process.exit(2);
}
const CHECK = process.argv.includes('--check');
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}

const { encode } = await import(`${SVC}engine/journal-codec.ts`);
const { decodeAll } = await import(`${SVC}engine/journal-io.ts`);

// Each kind of value an optional field can hold, as JSON.
const VALUES = [null, true, false, '', 'x', 0, 1, { 2: 0, b: 1 }, ['L']];

const AT = '2026-01-01T00:00Z';
const proof = { snapshot: { marketId: 'BTC/USDT', 10: 'ten', state: 'open', 1: 'one' }, action: 'place', hash: 'sha256:00' };
const instrument = {
  lot: '1',
  tick: '0.5',
  legs: [
    { ratio: '1', side: 'buy', symbol: 'BTC-PERP', extra: 1 },
    { side: 'sell', symbol: 'BTC-0329', ratio: '1' },
  ],
  kind: 'calendar',
  spreadId: 'SPR-1',
  extra: true,
};
const order = {
  tif: 'GTC',
  orderId: 'o-1',
  accountId: 'a',
  type: 'limit',
  side: 'buy',
  qty: '1',
  price: '100',
  stopPrice: null,
  extra: 'dropped',
};
const ORDER_OPTIONAL = [
  'ocoSiblingId',
  'bracket',
  'oco',
  'takeProfit',
  'stopLoss',
  'stopLossLimit',
  'takeProfitOrderId',
  'stopLossOrderId',
  'expireAt',
  'sessionId',
  'clientOrderId',
  'environment',
  'reduceOnly',
  'triggerRole',
  'triggerBy',
  'instrument',
  'positionQty',
  'displayQty',
  'iceberg',
  'trail',
  'mark',
  'strike',
  'expiry',
  'exercise',
  'minQty',
  'aon',
  'peg',
  'midpoint',
  'relative',
  'reference',
  'offset',
  'auction',
  'benchmark',
  'collar',
  'min',
  'max',
  'minNotional',
  'combo',
  'legs',
  'lifecycleProof',
];
const operator = { operatorId: 'op-1', confirmOperatorId: 'op-2' };
const sections = Object.fromEntries(
  ['fees', 'participation', 'matching', 'cancellation', 'settlement', 'liquidation', 'market_data', 'extra'].map((id) => [
    id,
    `${id} body`,
  ]),
);
const MODES = [
  'halt',
  'resume',
  'reduce_only',
  'resume_reduce_only',
  'post_only',
  'resume_post_only',
  'prelaunch',
  'open',
  'expire',
  'delist',
  'maintenance',
  'end_maintenance',
];

/** Base records of every kind, and the optional fields each reads. */
const BASES = [
  [{ kind: 'submit', marketId: 'BTC/USDT', at: AT, order }, []],
  [{ kind: 'cancel', marketId: 'BTC/USDT', at: AT, orderId: 'o-1' }, ['reason']],
  [{ kind: 'in_flight', marketId: 'BTC/USDT', at: AT, orderId: 'o-1', mutation: 'cancel', inFlight: true, qty: '2' }, ['inFlight', 'qty']],
  [{ kind: 'open_surveillance', marketId: 'BTC/USDT', at: AT, accountId: 'a', reason: 'spoofing' }, ['reason']],
  [{ kind: 'mass_cancel', marketId: 'BTC/USDT', at: AT, accountId: 'a' }, ['side']],
  [
    {
      kind: 'amend',
      marketId: 'BTC/USDT',
      at: AT,
      orderId: 'o-1',
      expectedVersion: 3,
      patch: { expiry: null, qty: '2', extra: 1 },
      lifecycleProof: proof,
    },
    ['lifecycleProof', 'expectedVersion'],
  ],
  [{ kind: 'mark', marketId: 'BTC/USDT', at: AT, mark: '101.5' }, ['mark']],
  ...MODES.map((kind) => [{ kind, marketId: 'BTC/USDT', at: AT, ...operator }, ['confirmOperatorId']]),
  [{ kind: 'halt_all', at: AT, ...operator, marketId: 'dropped' }, ['confirmOperatorId']],
  [{ kind: 'resume_all', at: AT, ...operator }, ['confirmOperatorId']],
  [{ kind: 'session_dead', at: AT, sessionId: 's-1' }, ['sessionId']],
  [{ kind: 'spread_list', marketId: 'SPR-1', at: AT, ...operator, instrument }, ['confirmOperatorId']],
  [
    {
      kind: 'rulebook_version',
      at: AT,
      ...operator,
      approvalId: 'ap-1',
      version: 'v1',
      effectiveAt: AT,
      supersedes: null,
      digest: 'sha256:ab',
      sections,
    },
    ['supersedes', 'confirmOperatorId'],
  ],
  [{ kind: 'split_brain', at: AT, ...operator }, ['confirmOperatorId']],
  [{ kind: 'clear_split_brain', at: AT, ...operator }, ['confirmOperatorId']],
];

const records = [];
const add = (name, record) => records.push({ name, record });
const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

let seq = 1;
for (const [base, optional] of BASES) {
  const rec = { seq: seq++, ...base };
  add(`${base.kind}`, rec);
  for (const key of Object.keys(base)) if (key !== 'kind') add(`${base.kind} without ${key}`, without(rec, key));
  for (const key of optional) for (const v of VALUES) add(`${base.kind} ${key}=${JSON.stringify(v)}`, { ...rec, [key]: v });
}
const submit = (o, extra = {}) => ({ seq: 7, kind: 'submit', marketId: 'M', at: 'T', order: o, ...extra });
// The order each field's variants are set on: the base order's fields, short, so the file stays small.
const lean = { orderId: 'o', accountId: 'a', type: 'limit', side: 'buy', qty: '1', price: '1', stopPrice: null, tif: 'GTC' };
for (const key of Object.keys(order)) add(`submit order without ${key}`, submit(without(order, key)));
for (const key of ORDER_OPTIONAL) for (const v of VALUES) add(`submit order.${key}=${JSON.stringify(v)}`, submit({ ...lean, [key]: v }));
for (const pair of [
  ['trail', 'mark'],
  ['iceberg', 'displayQty'],
  ['combo', 'legs'],
  ['peg', 'reference'],
  ['peg', 'offset'],
  ['collar', 'min'],
]) {
  for (const v of [null, true, '1'])
    add(`submit order ${pair.join('+')}=${JSON.stringify(v)}`, submit({ ...lean, [pair[0]]: v, [pair[1]]: v }));
}
for (const reason of ['requested', 'hold_unconfirmed', 'expired', 'Requested']) {
  add(`cancel reason=${reason}`, { seq: 2, kind: 'cancel', marketId: 'BTC/USDT', at: AT, orderId: 'o-1', reason });
}
for (const side of ['buy', 'sell'])
  add(`mass_cancel side=${side}`, { seq: 2, kind: 'mass_cancel', marketId: 'M', at: AT, accountId: 'a', side });
add('submit order.legs named', submit({ ...order, combo: true, legs: [{ strike: '1', name: 'a', ratio: '2', expiry: null }] }));
add('submit order.spread', submit({ ...order, spread: { anchorReference: '1.5', instrument, extra: 1 } }));
add('submit order.spread anchor absent', submit({ ...order, spread: { instrument } }));
add('submit order.spread null', submit({ ...order, spread: null }));
add('submit order.spread no instrument', submit({ ...order, spread: { anchorReference: '1' } }));
add('submit order.spread legs not a list', submit({ ...order, spread: { instrument: { ...instrument, legs: 'x' } } }));
add('submit order.spread a leg null', submit({ ...order, spread: { instrument: { ...instrument, legs: [null] } } }));
add('submit order.spread a leg a number', submit({ ...order, spread: { instrument: { ...instrument, legs: [5] } } }));
add('submit order.spread instrument a string', submit({ ...order, spread: { instrument: 'x' } }));
add('submit order null', submit(null));
add('submit order a number', submit(5));
add('submit order a list', submit([1]));
add('submit order a string', submit('x'));
add('submit text', submit({ ...order, accountId: 'a b\u0001"\\é😀\t', qty: '0.000000001' }));
add('submit numbers', { ...submit(order), seq: 1e21, at: 0.1 });
const amend = (patch) => ({ seq: 9, kind: 'amend', marketId: 'BTC/USDT', at: AT, orderId: 'o', expectedVersion: 1, patch });
for (const key of ['qty', 'price', 'stopPrice', 'tif', 'expireAt', 'strike', 'expiry']) {
  for (const v of VALUES) add(`amend patch.${key}=${JSON.stringify(v)}`, amend({ [key]: v }));
}
add('amend patch null', amend(null));
add('amend patch absent', without(amend({}), 'patch'));
add('amend patch a string', amend('x'));
const rulebook = BASES.find(([b]) => b.kind === 'rulebook_version')[0];
add('rulebook sections null', { seq: 3, ...rulebook, sections: null });
add('rulebook sections absent', without({ seq: 3, ...rulebook }, 'sections'));
add('rulebook sections partial', { seq: 3, ...rulebook, sections: { fees: 'f', matching: null } });
add('rulebook sections a string', { seq: 3, ...rulebook, sections: 'x' });
add('spread_list instrument null', { seq: 3, kind: 'spread_list', marketId: 'S', at: AT, operatorId: 'o', instrument: null });
add('unknown kind', { seq: 1, kind: 'fill', marketId: 'BTC/USDT' });
add('kind a number', { seq: 1, kind: 5 });
add('kind absent', { seq: 1 });
add('record a number', 5);
add('record a list', [1]);
add('record a string', 'submit');
add('record null', null);
add('record empty', {});

const codec = records.map(({ name, record }) => {
  const text = JSON.stringify(record);
  try {
    return { name, record: JSON.parse(text), encoded: encode(JSON.parse(text)) };
  } catch (err) {
    return { name, record: JSON.parse(text), throws: err instanceof Error ? err.message : String(err) };
  }
});

const line = (r) => JSON.stringify(r);
const one = line({ seq: 1, kind: 'cancel', marketId: 'BTC/USDT', at: AT, orderId: 'a' });
const two = line({ seq: 2, kind: 'cancel', marketId: 'BTC/USDT', at: AT, orderId: 'b' });
const torn = '{"seq":3,"kind":"cancel","marketId":"BTC/USDT","at":"x","orderId":"y';
const BODIES = [
  ['empty', ''],
  ['only newlines', '\n\n\n'],
  ['one with newline', `${one}\n`],
  ['one without newline', one],
  ['two', `${one}\n${two}\n`],
  ['torn tail', `${one}\n${two}\n${torn}`],
  ['torn tail then newline', `${one}\n${torn}\n`],
  ['torn tail then blank lines', `${one}\n${torn}\n \n\t\n`],
  ['torn tail then a nbsp line', `${one}\n${torn}\n \n`],
  ['torn tail then a bom line', `${one}\n${torn}\n﻿\n`],
  ['torn tail then a line separator line', `${one}\n${torn}\n \n`],
  ['torn tail then a nel line', `${one}\n${torn}\n\u0085\n`],
  ['torn middle', `${one}\n${torn}\n${two}\n`],
  ['corrupt first', `{not-json}\n${one}\n`],
  ['crlf', `${one}\r\n${two}\r\n`],
  ['blank lines between', `${one}\n\n   \n${two}\n`],
  ['a nbsp line between', `${one}\n \n${two}\n`],
  ['a non-object line', `5\n"x"\nnull\n[1]\n${one}\n`],
  ['a line with leading space', ` ${one}\n`],
  ['a line with a leading nbsp', ` ${one}\n`],
  ['a line with a bom', `﻿${one}\n`],
  ['duplicate keys', '{"seq":1,"kind":"cancel","seq":2,"1":"x","0":"y"}\n'],
  ['only a torn line', torn],
];
const decode = BODIES.map(([name, body]) => {
  try {
    return { name, body, records: JSON.stringify(decodeAll(body)) };
  } catch (err) {
    return { name, body, throws: err instanceof Error ? err.message : String(err) };
  }
});

// One case a line, as the journal itself is written: `codec` cases, then `decode` cases.
const out = `${[...codec.map((c) => ({ case: 'codec', ...c })), ...decode.map((c) => ({ case: 'decode', ...c }))].map((c) => JSON.stringify(c)).join('\n')}\n`;
const target = `${CRATE}tests/fixtures/journal-codec.golden.ndjson`;
if (CHECK) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== out) {
    console.error(`${NAME}: ${target} is stale; run without --check`);
    process.exit(1);
  }
  console.log(`${NAME}: up to date (${codec.length} records, ${decode.length} bodies)`);
} else {
  writeFileSync(target, out);
  console.log(`${NAME}: wrote ${codec.length} records, ${decode.length} bodies`);
}
