import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FUNDER_WARN_TESTERS,
  SEATS_WARN_SHARE,
  VENUE_WARN_SHARE,
  VENUE_WEIGHT_LIMIT,
  funderLimit,
  limitsLine,
  limitsReport,
  readLimits,
  seatsLimit,
  venueLimit,
  venueMinutes,
  tailSince,
  walletOutcomes,
  walletProviderLimit,
} from './beta-limits.mjs';

const FUNDER = '0x47e03ee499ba8efff97d8e6459ae2c64e8b28dc6';
const NOW = Date.parse('2026-11-27T09:30:20Z');
const outcomeLine = (at, outcome, status) =>
  JSON.stringify({ msg: 'protocol.embedded_provider_outcome', provider: 'turnkey', outcome, status, at });
const pinoLine = (ms) => JSON.stringify({ level: 30, time: ms, msg: 'request completed' });
const minuteLine = (minute, weight) => JSON.stringify({ msg: 'hl.venue_weight_minute', limit: 1200, minute, weight, byType: {} });

test('the funder warns once its free TEST USDC covers fewer than FUNDER_WARN_TESTERS testers, and says how many it covers', () => {
  // 68 free on 27 Nov: 2 testers of 25 each (#11063).
  const low = funderLimit({ funder: FUNDER, free: '68' });
  assert.equal(low.state, 'warn');
  assert.match(low.line, /68 free TEST USDC/);
  assert.match(low.line, /covers 2 testers/);
  assert.match(low.line, new RegExp(FUNDER));
  // Exactly the threshold's worth is ok; one unit under is warn.
  const edge = String(25 * FUNDER_WARN_TESTERS);
  assert.equal(funderLimit({ funder: FUNDER, free: edge }).state, 'ok');
  assert.equal(funderLimit({ funder: FUNDER, free: `${25 * FUNDER_WARN_TESTERS - 1}.99999999` }).state, 'warn');
  assert.match(funderLimit({ funder: FUNDER, free: '1000' }).line, /covers 40 testers/);
});

test('the funder is unread, never ok, when its address or balance could not be read', () => {
  const noFunder = funderLimit({ funder: null, free: null });
  assert.equal(noFunder.state, 'unread');
  assert.match(noFunder.line, /funder is not named/);
  const noRead = funderLimit({ funder: FUNDER, free: null, error: 'testnet info spotClearinghouseState: HTTP 500' });
  assert.equal(noRead.state, 'unread');
  assert.match(noRead.line, /HTTP 500/);
});

test('venue weight reads the last full minute against the 1,200 limit and warns at VENUE_WARN_SHARE of it', () => {
  assert.equal(VENUE_WEIGHT_LIMIT, 1200);
  const text = [
    'not json',
    minuteLine('2026-11-27T09:27:00.000Z', 632),
    JSON.stringify({ msg: 'other', weight: 9999 }),
    minuteLine('2026-11-27T09:28:00.000Z', 1046),
    minuteLine('2026-11-27T09:29:00.000Z', 400),
  ].join('\n');
  const minutes = venueMinutes(text);
  assert.deepEqual(
    minutes.map((m) => m.weight),
    [632, 1046, 400],
  );
  const v = venueLimit({ minutes, now: NOW });
  assert.equal(v.state, 'warn', 'the peak of the last ten minutes, 1046, is over 80% of 1200');
  assert.match(v.line, /400 of 1200 in the minute from 09:29 UTC/);
  assert.match(v.line, /peak 1046/);
  const calm = venueLimit({
    minutes: venueMinutes(minuteLine('2026-11-27T09:29:00.000Z', Math.ceil(1200 * VENUE_WARN_SHARE) - 1)),
    now: NOW,
  });
  assert.equal(calm.state, 'ok');
  const hot = venueLimit({ minutes: venueMinutes(minuteLine('2026-11-27T09:29:00.000Z', Math.ceil(1200 * VENUE_WARN_SHARE))), now: NOW });
  assert.equal(hot.state, 'warn');
});

test('venue weight with no minute logged lately reads as none spent, and with no log at all as unread', () => {
  const idle = venueLimit({ minutes: venueMinutes(minuteLine('2026-11-27T08:00:00.000Z', 1100)), now: NOW });
  assert.equal(idle.state, 'ok');
  assert.match(idle.line, /0 of 1200/);
  assert.match(idle.line, /08:00 UTC/);
  const none = venueLimit({ minutes: null, now: NOW });
  assert.equal(none.state, 'unread');
});

test('login seats count the Access viewers seen, against a limit only when one is set', () => {
  const unset = seatsLimit({ seen: 7, limit: null });
  assert.equal(unset.state, 'unread');
  assert.match(unset.line, /7 viewers seen/);
  assert.match(unset.line, /BETA_ACCESS_SEATS/);
  assert.equal(seatsLimit({ seen: 39, limit: 50 }).state, 'ok');
  const warn = seatsLimit({ seen: Math.ceil(50 * SEATS_WARN_SHARE), limit: 50 });
  assert.equal(warn.state, 'warn');
  assert.match(warn.line, /40 of 50 seats/);
  assert.match(warn.line, /10 left/);
});

test('the wallet provider warns on any quota refusal (429) in the last hour, and counts each outcome (#11063)', () => {
  const at = (minutesAgo) => NOW - minutesAgo * 60_000;
  const outcomes = [
    { at: at(70), outcome: 'quota', status: 429 }, // older than the hour: not counted
    { at: at(50), outcome: 'signed', status: 200 },
    { at: at(20), outcome: 'refused', status: 401 },
    { at: at(10), outcome: 'down', status: null },
  ];
  const ok = walletProviderLimit({ outcomes, now: NOW });
  assert.equal(ok.state, 'ok');
  assert.match(
    ok.line,
    /1 of 3 signatures at the owner's provider signed in the last hour, 0 refused over its signing quota \(429\), 1 refused otherwise, 1 unanswered/,
  );
  assert.match(ok.line, /what is left of its quota is not read/);
  const warn = walletProviderLimit({ outcomes: [...outcomes, { at: at(1), outcome: 'quota', status: 429 }], now: NOW });
  assert.equal(warn.state, 'warn');
  assert.match(warn.line, /1 refused over its signing quota \(429\)/);
  assert.match(warn.line, /the last quota refusal at 09:29 UTC/);
  // Exactly an hour ago is outside the window.
  assert.equal(walletProviderLimit({ outcomes: [{ at: at(60), outcome: 'quota', status: 429 }], now: NOW }).state, 'ok');
});

test('the wallet provider with no signatures in the hour is ok and says so; with no log it is unread, never ok', () => {
  const none = walletProviderLimit({ outcomes: [], now: NOW });
  assert.equal(none.state, 'ok');
  assert.match(none.line, /no signature asked at the owner's provider in the last hour/);
  const test = walletProviderLimit({ provider: 'test', outcomes: [], now: NOW });
  assert.equal(test.state, 'ok');
  assert.match(test.line, /new wallets at the TEST provider/);
  assert.match(test.line, /no signature at the owner's provider in the last hour/);
  // An older wallet at the owner's provider still signs there while new ones are TEST: its quota refusals still warn.
  const older = walletProviderLimit({ provider: 'test', outcomes: [{ at: NOW - 60_000, outcome: 'quota', status: 429 }], now: NOW });
  assert.equal(older.state, 'warn');
  assert.match(older.line, /new wallets at the TEST provider/);
  const unread = walletProviderLimit({ outcomes: null, now: NOW });
  assert.equal(unread.state, 'unread');
  assert.match(unread.line, /no protocol\.log/);
});

test('walletOutcomes reads only well-formed outcome lines', () => {
  const text = [
    pinoLine(NOW),
    outcomeLine('2026-11-27T09:00:00.000Z', 'quota', 429),
    '{"msg":"protocol.embedded_provider_outcome","outcome":"busy","at":"2026-11-27T09:00:00.000Z"}',
    'protocol.embedded_provider_outcome not json',
    outcomeLine('2026-11-27T09:01:00.000Z', 'down', null),
  ].join('\n');
  assert.deepEqual(walletOutcomes(text), [
    { at: Date.parse('2026-11-27T09:00:00.000Z'), outcome: 'quota', status: 429 },
    { at: Date.parse('2026-11-27T09:01:00.000Z'), outcome: 'down', status: null },
  ]);
});

test('tailSince reads a large log back only to the first line older than the hour, at most `max` bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-tail-'));
  const file = path.join(root, 'protocol.log');
  const old = Array.from({ length: 2000 }, () => pinoLine(NOW - 3 * 3600_000)).join('\n');
  const recent = [pinoLine(NOW - 30 * 60_000), outcomeLine(new Date(NOW - 60_000).toISOString(), 'quota', 429)].join('\n');
  fs.writeFileSync(file, `${old}\n${recent}\n`);
  const text = tailSince(file, NOW - 3600_000, { chunk: 4096 });
  assert.ok(text.length < old.length / 2, 'stops well before the start of the file');
  assert.ok(text.endsWith(`${recent}\n`));
  assert.deepEqual(
    walletOutcomes(text).map((o) => o.outcome),
    ['quota'],
  );
  // A file with no line older than the hour is read whole, up to `max`.
  assert.equal(tailSince(file, 0, { chunk: 4096 }).length, fs.statSync(file).size);
  assert.ok(tailSince(file, 0, { chunk: 4096, max: 8192 }).length <= 8192);
  assert.equal(tailSince(path.join(root, 'missing.log'), 0), null);
});

test('one line for the record names each limit and its state, worst first', () => {
  const line = limitsLine([
    { name: 'funder', state: 'warn', line: 'funder: x' },
    { name: 'venue', state: 'ok', line: 'venue: y' },
    { name: 'seats', state: 'unread', line: 'seats: z' },
    { name: 'wallet', state: 'unread', line: 'wallet: w' },
  ]);
  assert.match(line, /^limits: warn \(funder\); unread \(seats, wallet\); ok \(venue\)$/);
});

test('readLimits reads all four live, from the funded file, the venue log, the invited file and the testnet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-limits-'));
  const paths = {
    testnet: path.join(root, 'testnet-funded.json'),
    invited: path.join(root, 'invited.json'),
    venueLog: path.join(root, 'test-venue.log'),
    protocolLog: path.join(root, 'protocol.log'),
  };
  fs.writeFileSync(paths.testnet, JSON.stringify({ funder: FUNDER, accounts: {} }));
  fs.writeFileSync(
    paths.invited,
    JSON.stringify({ tokens: { 'a-b-c-0123456789': '2026-11-27T00:00:00Z', 'd-e-0123456789': '2026-11-20T00:00:00Z' } }),
  );
  fs.writeFileSync(paths.venueLog, `${'x'.repeat(300_000)}\n${minuteLine('2026-11-27T09:29:00.000Z', 120)}\n`);
  fs.writeFileSync(paths.protocolLog, `${pinoLine(NOW - 2 * 3600_000)}\n${outcomeLine('2026-11-27T09:20:00.000Z', 'quota', 429)}\n`);
  const asked = [];
  const limits = await readLimits(paths, {
    now: NOW,
    seatLimit: '50',
    spotFree: async (address) => {
      asked.push(address);
      return '68';
    },
  });
  assert.deepEqual(asked, [FUNDER]);
  assert.deepEqual(
    limits.map((l) => [l.name, l.state]),
    [
      ['wallet-provider', 'warn'],
      ['funder', 'warn'],
      ['venue-weight', 'ok'],
      ['login-seats', 'ok'],
    ],
  );
  assert.match(limits[3].line, /2 of 50 seats/);
  // A failed testnet read is unread, not a crash and not ok.
  const broken = await readLimits(paths, {
    now: NOW,
    seatLimit: '',
    spotFree: async () => {
      throw new Error('HTTP 429');
    },
  });
  assert.equal(broken[1].state, 'unread');
  assert.match(broken[1].line, /HTTP 429/);
  assert.equal(broken[3].state, 'unread');
});

test('the status report puts each limit on its own line, state first', () => {
  const r = limitsReport([
    { name: 'funder', state: 'warn', line: 'testnet funder: a' },
    { name: 'venue-weight', state: 'ok', line: 'venue weight: b' },
  ]);
  assert.equal(r, '  warn   testnet funder: a\n  ok     venue weight: b');
});
