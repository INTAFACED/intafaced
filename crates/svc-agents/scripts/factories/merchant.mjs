// The merchant's parity cases (`record-factories.mjs`): the policy, every branch of the approval-rate watch, and the
// metered run's refusals before any session. A case's `port` is svc-pay's metrics answer, served to the real HTTP port
// by a fake fetch (`{ status, body }`, or `{ throws: true }`), signed with `port.secret` when it names one.

const NOW = '2026-11-19T00:00:00.000Z';
const FRESH = '2026-11-18T23:59:30.000Z';

const p = (railId, approvalRate = '0.70', attempts = 100, extra = {}) => ({
  railId,
  approvalRate,
  attempts,
  asOf: FRESH,
  maxAgeMs: 120000,
  ...extra,
});

const watchCases = [
  ['plane omitted', { points: [p('card-visa')], now: NOW }],
  ['plane dark', { points: [p('card-visa')], payPlane: 'dark', now: NOW }],
  [
    'the board, default threshold',
    { points: [p('card-visa', '0.70'), p('card-mc', '0.90'), p('sepa', '0.85')], payPlane: 'live', now: NOW },
  ],
  ['a threshold', { points: [p('card-visa', '0.70'), p('card-mc', '0.90')], payPlane: 'live', threshold: '0.95', now: NOW }],
  ['threshold 1', { points: [p('a', '1'), p('b', '0.999')], payPlane: 'live', threshold: '1', now: NOW }],
  ['threshold 1.000', { points: [p('a', '1.0'), p('b', '0')], payPlane: 'live', threshold: '1.000', now: NOW }],
  ['threshold 0', { points: [p('a', '0')], payPlane: 'live', threshold: '0', now: NOW }],
  ...['1.01', '.5', '0.', '01', '1.5', 'abc', '', ' 0.5', '0.5 ', '1e-1', '-0'].map((t) => [
    `threshold ${JSON.stringify(t)}`,
    { points: [p('a')], payPlane: 'live', threshold: t, now: NOW },
  ]),
  [
    'a rate one ulp under the threshold reads equal',
    { points: [p('a', '0.84999999999999999999'), p('b', '0.8499999999999999')], payPlane: 'live', threshold: '0.85', now: NOW },
  ],
  ['no points', { points: [], payPlane: 'live', now: NOW }],
  ['an allowlist', { points: [p('a', '0.5'), p('b', '0.5'), p('c', '0.95')], payPlane: 'live', railAllowlist: ['a', 'c', 'zz'], now: NOW }],
  ['an empty allowlist', { points: [p('a', '0.5')], payPlane: 'live', railAllowlist: [], now: NOW }],
  ['an allowlist matching nothing', { points: [p('a', '0.5')], payPlane: 'live', railAllowlist: ['zz'], now: NOW }],
  ['an allowlist leaving out a hole', { points: [p('a', '0.5'), p('b', null, null)], payPlane: 'live', railAllowlist: ['a'], now: NOW }],
  ['a null rate', { points: [p('a', '0.5'), p('b', null)], payPlane: 'live', now: NOW }],
  ['null attempts', { points: [p('a', '0.5'), p('b', '0.5', null)], payPlane: 'live', now: NOW }],
  ['negative attempts', { points: [p('a', '0.5', -1)], payPlane: 'live', now: NOW }],
  ['zero attempts only', { points: [p('a', '0.0', 0), p('b', '0.0', 0)], payPlane: 'live', now: NOW }],
  ['zero attempts beside an alert', { points: [p('a', '0.0', 0), p('b', '0.5', 10)], payPlane: 'live', now: NOW }],
  ['a raised floor', { points: [p('a', '0.5', 9), p('b', '0.5', 10), p('c', '0.95', 10)], payPlane: 'live', minAttempts: 10, now: NOW }],
  ['a bad rate', { points: [p('a', '0.5x')], payPlane: 'live', now: NOW }],
  ['a rate over 1', { points: [p('a', '1.5')], payPlane: 'live', now: NOW }],
  ['a bad rate under a low sample', { points: [p('a', 'nope', 0)], payPlane: 'live', now: NOW }],
  ['stale', { points: [p('a', '0.5', 100, { asOf: '2026-11-18T23:00:00.000Z', maxAgeMs: 60000 })], payPlane: 'live', now: NOW }],
  ['stale beside fresh', { points: [p('a', '0.5'), p('b', '0.5', 100, { asOf: '2026-11-18T23:00:00.000Z' })], payPlane: 'live', now: NOW }],
  [
    'stale and a hole',
    { points: [p('a', null, null), p('b', '0.5', 100, { asOf: '2026-11-18T23:00:00.000Z' })], payPlane: 'live', now: NOW },
  ],
  ['in the future', { points: [p('a', '0.5', 100, { asOf: '2026-11-19T00:00:00.001Z' })], payPlane: 'live', now: NOW }],
  ['exactly at its age', { points: [p('a', '0.5', 100, { asOf: '2026-11-18T23:58:00.000Z' })], payPlane: 'live', now: NOW }],
  ['one ms past its age', { points: [p('a', '0.5', 100, { asOf: '2026-11-18T23:57:59.999Z' })], payPlane: 'live', now: NOW }],
  ['a time Date.parse reads loosely', { points: [p('a', '0.5', 100, { asOf: 'Nov 18 2026 23:59:00 GMT' })], payPlane: 'live', now: NOW }],
  ['a space for the T', { points: [p('a', '0.5', 100, { asOf: '2026-11-18 23:59:00' })], payPlane: 'live', now: NOW }],
  ['an unparsed time', { points: [p('a', '0.5', 100, { asOf: 'yesterday' })], payPlane: 'live', now: NOW }],
  ['the clock, no now', { points: [p('a', '0.5', 100, { asOf: '2026-11-18T23:59:59.000Z' })], payPlane: 'live' }],
  ['a now with microseconds', { points: [p('a', '0.5')], payPlane: 'live', now: '2026-11-19T00:00:00.123456Z' }],
  [
    'a now past the month end',
    { points: [p('a', '0.5', 100, { asOf: '2026-02-28T23:59:00.000Z' })], payPlane: 'live', now: '2026-02-30T00:00:00Z' },
  ],
];

const run = (name, input, extra = {}) => ({ name: `runSession: ${name}`, path: 'merchant.runSession', input, ...extra });
const live = { plane: 'live', points: [p('card-visa', '0.99', 10000)], now: NOW };
const good = { ok: true, points: [p('card-visa')] };

export const cases = [
  { name: 'policy', path: 'merchant.policy' },
  ...watchCases.map(([name, input]) => ({ name: `watch: ${name}`, path: 'merchant.watch', input })),
  { name: 'watch: a key may read', path: 'merchant.watch', input: { points: [], payPlane: 'live', now: NOW }, scopes: ['agents:read'] },
  run('dark', { plane: 'dark', points: [p('card-visa')] }),
  run('dark, fat fixture rates', {
    plane: 'dark',
    points: [p('card-visa', '0.99', 10000), p('card-mc', '0.98', 10000)],
    threshold: '0.85',
  }),
  run('live, no port: body points are not live truth', live),
  run('live, no port, no points', { plane: 'live', points: [] }),
  run('a key may not run', { plane: 'dark', points: [] }, { scopes: ['agents:read'] }),
  ...[
    ['pay down', { throws: true }],
    ['pay 503 refusal', { status: 503, body: { ok: false, reason: 'no_live_metrics' } }],
    ['pay 404 with points', { status: 404, body: good }],
    ['pay 500', { status: 500, body: {} }],
    ['a refusal body on 200', { status: 200, body: { ok: false, reason: 'no_live_metrics' } }],
    ['no points', { status: 200, body: { ok: true, points: [] } }],
    ['points not a list', { status: 200, body: { ok: true, points: { a: p('a') } } }],
    ['ok not true', { status: 200, body: { ok: 'true', points: [p('a')] } }],
    ['no ok', { status: 200, body: { points: [p('a')] } }],
    ['a list body', { status: 200, body: [p('a')] }],
    ['a string body', { status: 200, body: 'ok' }],
    ['a null body', { status: 200, body: null }],
    ['a short secret cannot sign', { status: 200, body: good, secret: 'placeholder-short' }],
  ].map(([name, port]) => run(`live port: ${name}`, live, { port })),
];

export async function deps(c) {
  if (c.port === undefined) return {};
  const { createHttpPayMetricsPort } = await import(
    new URL('../../../../services/svc-agents/src/merchant/pay-metrics-http-port.ts', import.meta.url).href
  );
  const fetchImpl = async () => {
    if (c.port.throws) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify(c.port.body), { status: c.port.status, headers: { 'content-type': 'application/json' } });
  };
  return {
    payMetricsPort: createHttpPayMetricsPort({
      payUrl: 'http://pay.test/',
      internalSecret: c.port.secret ?? 'placeholder-agents-merchant-parity-internal-secret',
      fetchImpl,
    }),
  };
}
