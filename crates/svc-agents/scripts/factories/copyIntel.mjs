// Copy-Intel's parity cases (`record-factories.mjs`): the policy, the pure stats build and the directory over every
// branch they read, and the metered run's refusals before any session. A case's `port` is svc-trade's copy leaders
// answer (`{ status, body }`, `{ status, bodyText }` for a body that is not JSON, or `{ throws: true }`), served to the
// real HTTP port by a fake fetch. Each port also holds what the real TypeScript port made of that answer (`sample`)
// and the request it sent (`sent`), so the Rust port is held to both; the run itself refuses `no_live_leaders` before
// any session while the owner's live plane stays closed, as it is in the recording's environment.

const PORT_SOURCE = new URL('../../../../services/svc-agents/src/copy-intel/copy-leader-fixtures-http-port.ts', import.meta.url).href;
const { createHttpCopyLeaderFixturesPort } = await import(PORT_SOURCE);

export const TRADE_URL = 'http://trade.test/';
export const INTERNAL_SECRET = 'placeholder-agents-copy-intel-internal-secret';

const NOW = '2026-11-19T00:00:00.000Z';
const W0 = '2026-11-01T00:00:00.000Z';
const W1 = '2026-11-08T00:00:00.000Z';

const f = (leaderId, over = {}) => ({
  leaderId,
  realisedPnl: '12.5',
  closedTrades: 10,
  winningTrades: 6,
  windowStart: W0,
  windowEnd: W1,
  source: 'platform-fills',
  ...over,
});

const BOARD = [
  f('leader-c', { realisedPnl: '-3.25', closedTrades: 3, winningTrades: 2 }),
  f('leader-a', { realisedPnl: '100', closedTrades: 8, winningTrades: 1 }),
  f('Leader-B', { realisedPnl: ' 1.5 ', closedTrades: 20000, winningTrades: 1 }),
  f('leader-z', { closedTrades: 0, winningTrades: 0 }),
  f('leader-n', { realisedPnl: null }),
  f('leader-m', { closedTrades: null }),
  f('leader-w', { winningTrades: null }),
  f('leader-neg', { closedTrades: -1, winningTrades: 0 }),
  f('leader-negw', { closedTrades: 1, winningTrades: -1 }),
  f('leader-over', { closedTrades: 2, winningTrades: 3 }),
  f('leader-exp', { realisedPnl: '1e5' }),
  f('leader-19', { realisedPnl: '1.1234567890123456789' }),
  f('leader-18', { realisedPnl: '-1.123456789012345678' }),
  f('leader-big', { realisedPnl: '123456789012345678901' }),
  f('leader-text', { realisedPnl: 'twelve' }),
  f('leader-dot', { realisedPnl: '.5' }),
  f('leader-a', { realisedPnl: '7', closedTrades: 3, winningTrades: 3, source: 'second-source' }),
  f('leader-same', { windowStart: W1, windowEnd: W1 }),
  f('leader-loose', { windowStart: 'Nov 1 2026', windowEnd: '2026-11-08 12:00:00' }),
  f('élan', { closedTrades: 7, winningTrades: 5 }),
  f('\u{1F600}-emoji', { closedTrades: 9, winningTrades: 4 }),
  f('～-wide', { closedTrades: 6, winningTrades: 5 }),
];

const build = (name, input) => ({ name: `buildStats: ${name}`, path: 'copyIntel.buildStats', input });
const buildCases = [
  build('nothing', { fixtures: [] }),
  build('the board', { fixtures: BOARD, now: NOW }),
  build('the board at the clock', { fixtures: BOARD }),
  build('a dark plane', { fixtures: BOARD, copyPlane: 'dark' }),
  build('a live plane, no allowlist', { fixtures: BOARD, copyPlane: 'live' }),
  build('a live plane, an allowlist', { fixtures: BOARD, copyPlane: 'live', leaderAllowlist: ['leader-a'] }),
  build('a dark plane, nothing', { fixtures: [], copyPlane: 'dark' }),
  build('an allowlist', { fixtures: BOARD, leaderAllowlist: ['leader-a', 'leader-c', 'leader-n', 'nobody'], now: NOW }),
  build('an empty allowlist', { fixtures: BOARD.slice(0, 2), leaderAllowlist: [], now: NOW }),
  build('an allowlist matching nothing', { fixtures: BOARD, leaderAllowlist: ['nobody'] }),
  build('the incomplete rows and their neighbours', { fixtures: BOARD.slice(4, 16) }),
  build('incomplete and not allowed', { fixtures: BOARD.slice(4, 8), leaderAllowlist: ['leader-n', 'leader-m'] }),
  build('an end before its start', { fixtures: [f('a'), f('b', { windowStart: W1, windowEnd: W0 })] }),
  build('an unreadable start', { fixtures: [f('a', { windowStart: 'soon' })] }),
  build('an unreadable end', { fixtures: [f('a', { windowEnd: '2026-13-40T00:00:00Z' })] }),
  build('a bad window behind an incomplete row', { fixtures: [f('a', { realisedPnl: null, windowStart: 'x' })] }),
  build('a bad window after a good row', { fixtures: [f('a'), f('b', { windowEnd: 'never' })], now: NOW }),
  build('a bad window not allowed', {
    fixtures: [f('a'), f('b', { windowEnd: 'never' })],
    leaderAllowlist: ['a'],
    now: NOW,
  }),
  build('a fractional count', { fixtures: [f('a', { closedTrades: 1.5 })] }),
  build('rates', {
    fixtures: [
      f('r1', { closedTrades: 3, winningTrades: 2 }),
      f('r2', { closedTrades: 8, winningTrades: 1 }),
      f('r3', { closedTrades: 16, winningTrades: 1 }),
      f('r4', { closedTrades: 20000, winningTrades: 1 }),
      f('r5', { closedTrades: 200000, winningTrades: 1 }),
      f('r6', { closedTrades: 7, winningTrades: 7 }),
      f('r7', { closedTrades: 9007199254740991, winningTrades: 3 }),
      f('r8', { closedTrades: 1000000, winningTrades: 999950 }),
    ],
    now: NOW,
  }),
  build('a duplicate leader', { fixtures: [f('dup', { source: 'one' }), f('dup', { source: 'two', winningTrades: 1 })], now: NOW }),
  build('a bad now', { fixtures: [f('a')], now: 'yesterday' }),
  build('an extra key', { fixtures: [{ ...f('a'), followers: 9 }], rankBy: 'pnl', now: NOW }),
];

const STATS = [
  { leaderId: 'leader-c', realisedPnl: '-3.25', closedTrades: 3, winRate: '0.6667', windowStart: W0, windowEnd: W1 },
  { leaderId: 'leader-a', realisedPnl: '100', closedTrades: 8, winRate: '0.1250', windowStart: W0, windowEnd: W1 },
  { leaderId: 'Leader-B', realisedPnl: '1.5', closedTrades: 4, winRate: '0.2500', windowStart: W0, windowEnd: W1 },
  { leaderId: 'élan', realisedPnl: '0', closedTrades: 0, winRate: '0.0000', windowStart: W0, windowEnd: W1 },
  { leaderId: '\u{1F600}-emoji', realisedPnl: '1', closedTrades: 1, winRate: '1.0000', windowStart: W0, windowEnd: W1 },
  { leaderId: '～-wide', realisedPnl: '2', closedTrades: 2, winRate: '0.5000', windowStart: W0, windowEnd: W1 },
  { leaderId: 'leader-a', realisedPnl: '5', closedTrades: 5, winRate: '0.2000', windowStart: W0, windowEnd: 'any text' },
];

const dir = (name, input) => ({ name: `presentDirectory: ${name}`, path: 'copyIntel.presentDirectory', input });
const dirCases = [
  dir('the directory', { stats: STATS }),
  dir('mode directory', { stats: STATS, mode: 'directory', sortBy: 'leaderId' }),
  dir('blank mode and sort', { stats: STATS, mode: '', sortBy: '' }),
  dir('nothing', { stats: [] }),
  dir('nothing, a leaderboard', { stats: [], mode: 'leaderboard' }),
  dir('nothing, a pnl sort', { stats: [], sortBy: 'pnl' }),
  ...['marketing_board', 'leaderboard', 'top_traders', 'top_trader', 'recommended', 'recommended_for_you', 'ranked'].map((mode) =>
    dir(`mode ${mode}`, { stats: STATS, mode }),
  ),
  dir('another mode', { stats: STATS, mode: 'gallery' }),
  dir('a capitalised mode', { stats: STATS, mode: 'Directory' }),
  dir('a marketing mode with a good sort', { stats: STATS, mode: 'leaderboard', sortBy: 'leaderId' }),
  ...['returns', 'return', 'pnl', 'realisedPnl', 'realizedPnl', 'winRate', 'win_rate', 'performance', 'rank', 'profit', 'roi'].map(
    (sortBy) => dir(`sort ${sortBy}`, { stats: STATS, sortBy }),
  ),
  dir('another sort', { stats: STATS, sortBy: 'name' }),
  dir('a capitalised sort', { stats: STATS, sortBy: 'LeaderId' }),
  dir('a filter', { stats: STATS, leaderFilter: ['leader-a', 'élan', 'nobody'] }),
  dir('an empty filter', { stats: STATS, leaderFilter: [] }),
  dir('a filter matching nothing', { stats: STATS, leaderFilter: ['nobody'] }),
  dir('an extra key', { stats: [{ ...STATS[0], followers: 3 }], limit: 1 }),
];

const run = (name, input, extra = {}) => ({ name: `runSession: ${name}`, path: 'copyIntel.runSession', input, ...extra });

/** What the real TypeScript port makes of one svc-trade answer, and the request it sent. */
async function portOf(reply) {
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = { method: init.method, url: String(url), headers: Object.keys(init.headers).sort(), accept: init.headers.accept };
    if (reply.throws) throw new Error('connect ECONNREFUSED');
    const body = reply.bodyText ?? JSON.stringify(reply.body);
    return new Response(body, { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  const port = createHttpCopyLeaderFixturesPort({ tradeUrl: TRADE_URL, internalSecret: INTERNAL_SECRET, fetchImpl });
  const sample = await port.sample();
  return { ...reply, sample, sent };
}

const LIVE_ROWS = [f('leader-a'), f('leader-b', { realisedPnl: '3.0', winningTrades: 2 })];
const replies = [
  ['two leaders', { status: 200, body: { ok: true, fixtures: LIVE_ROWS } }],
  ['rows of other shapes', { status: 200, body: { ok: true, fixtures: [{ leaderId: 5, extra: true }, 'text', null] } }],
  ['no rows', { status: 200, body: { ok: true, fixtures: [] } }],
  ['a refusal', { status: 503, body: { ok: false, reason: 'no_live_leaders' } }],
  ['a refusal at 200', { status: 200, body: { ok: false, reason: 'no_live_leaders' } }],
  ['ok not true', { status: 200, body: { ok: 'true', fixtures: LIVE_ROWS } }],
  ['fixtures not a list', { status: 200, body: { ok: true, fixtures: { 0: LIVE_ROWS[0] } } }],
  ['a list', { status: 200, body: [LIVE_ROWS[0]] }],
  ['null', { status: 200, body: null }],
  ['not JSON', { status: 200, bodyText: '{"ok":true,' }],
  ['a 500', { status: 500, body: { ok: true, fixtures: LIVE_ROWS } }],
  ['a 201', { status: 201, body: { ok: true, fixtures: LIVE_ROWS } }],
  ['trade down', { throws: true }],
];
const ports = [];
for (const [name, reply] of replies) ports.push([name, await portOf(reply)]);

const runCases = [
  run('dark', { plane: 'dark', fixtures: [f('leader-a')] }),
  run('dark, nothing', { plane: 'dark', fixtures: [] }),
  run('dark, an allowlist', { plane: 'dark', fixtures: [f('leader-a')], leaderAllowlist: ['leader-a'], now: NOW }),
  run('live, no port', { plane: 'live', fixtures: [f('leader-a')], leaderAllowlist: ['leader-a'] }),
  run('live, no port, nothing', { plane: 'live', fixtures: [] }),
  run('live, no port, a returns sort', { plane: 'live', fixtures: [f('leader-a')], rankBy: 'realisedPnl' }),
  run('a key may not run', { plane: 'dark', fixtures: [f('leader-a')] }, { scopes: ['agents:read'] }),
  run('an unknown plane', { plane: 'fixtures', fixtures: [] }),
  run('a bad now', { plane: 'dark', fixtures: [], now: 'later' }),
  ...ports.flatMap(([name, port]) => [
    run(`live port, ${name}`, { plane: 'live', fixtures: [], leaderAllowlist: ['leader-a'], now: NOW }, { port }),
    run(`live port, ${name}, no allowlist`, { plane: 'live', fixtures: [f('leader-a')] }, { port }),
  ]),
  run('dark, a port', { plane: 'dark', fixtures: [] }, { port: ports[0][1] }),
];

export const cases = [{ name: 'policy', path: 'copyIntel.policy' }, ...buildCases, ...dirCases, ...runCases];

export async function deps(c) {
  if (c.port === undefined) return {};
  const fetchImpl = async () => {
    if (c.port.throws) throw new Error('connect ECONNREFUSED');
    const body = c.port.bodyText ?? JSON.stringify(c.port.body);
    return new Response(body, { status: c.port.status, headers: { 'content-type': 'application/json' } });
  };
  return {
    copyLeaderFixturesPort: createHttpCopyLeaderFixturesPort({ tradeUrl: TRADE_URL, internalSecret: INTERNAL_SECRET, fetchImpl }),
  };
}
