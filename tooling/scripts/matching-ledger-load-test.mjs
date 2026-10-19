#!/usr/bin/env node
/**
 * D26-P3-03 — matching + ledger load-test stub (fail-closed).
 *
 * This is not a soak. It does not POST orders, does not post ledger
 * transactions, and does not add k6/artillery/autocannon to the money path.
 * Default invocation exits 2. LOAD_TEST_ACK=1 only prints the local target
 * plan. LOAD_TEST_SOAK=1 is still refused (no host; traffic is not generated).
 *
 * Runbook: docs/runbooks/D26-P3-03-MATCHING-LEDGER-LOAD-TEST.md
 *
 *   node tooling/scripts/matching-ledger-load-test.mjs
 *   node tooling/scripts/matching-ledger-load-test.mjs --self-test
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * @param {string} raw
 * @returns {{ ok: true, href: string } | { ok: false, reason: string }}
 */
export function parseLoopbackHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return { ok: false, reason: `not a URL: ${raw}` };
  }
  if (u.protocol !== 'http:') {
    return { ok: false, reason: `only http:// loopback is allowed (got ${u.protocol})` };
  }
  if (!LOOPBACK_HOSTS.has(u.hostname)) {
    return { ok: false, reason: `host is not loopback: ${u.hostname}` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'credentials in the URL are refused' };
  }
  return { ok: true, href: u.href };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ allow: boolean, code: number, reason: string, matching?: string, ledger?: string }}
 */
export function evaluateLoadTestIntent(env) {
  if (String(env.LOAD_TEST_ACK ?? '') !== '1') {
    return {
      allow: false,
      code: 2,
      reason: 'refused: set LOAD_TEST_ACK=1 to print the local target plan (no traffic)',
    };
  }

  const appEnv = String(env.APP_ENV ?? '').toLowerCase();
  const nodeEnv = String(env.NODE_ENV ?? '').toLowerCase();
  if (appEnv === 'production' || appEnv === 'prod' || nodeEnv === 'production') {
    return { allow: false, code: 2, reason: 'refused: production APP_ENV/NODE_ENV' };
  }

  const matchingRaw = env.MATCHING_HTTP_URL ?? 'http://127.0.0.1:4005';
  const ledgerRaw = env.LEDGER_HTTP_URL ?? 'http://127.0.0.1:4001';
  const matching = parseLoopbackHttpUrl(matchingRaw);
  if (!matching.ok) {
    return { allow: false, code: 2, reason: `refused matching target: ${matching.reason}` };
  }
  const ledger = parseLoopbackHttpUrl(ledgerRaw);
  if (!ledger.ok) {
    return { allow: false, code: 2, reason: `refused ledger target: ${ledger.reason}` };
  }

  if (String(env.LOAD_TEST_SOAK ?? '') === '1') {
    return {
      allow: false,
      code: 2,
      reason: 'refused: LOAD_TEST_SOAK=1 — soak is not implemented (no host; this stub generates no traffic)',
    };
  }

  return {
    allow: true,
    code: 0,
    reason: 'ack accepted; plan only; no HTTP; numbers are not product law',
    matching: matching.href,
    ledger: ledger.href,
  };
}

function selfTest() {
  /** @type {Array<[string, NodeJS.ProcessEnv, boolean, string]>} */
  const cases = [
    ['no ack', {}, false, 'LOAD_TEST_ACK'],
    ['ack=0', { LOAD_TEST_ACK: '0' }, false, 'LOAD_TEST_ACK'],
    ['production APP_ENV', { LOAD_TEST_ACK: '1', APP_ENV: 'production' }, false, 'production'],
    ['production NODE_ENV', { LOAD_TEST_ACK: '1', NODE_ENV: 'production' }, false, 'production'],
    ['remote matching URL', { LOAD_TEST_ACK: '1', MATCHING_HTTP_URL: 'https://matching.example.com' }, false, 'matching target'],
    ['remote ledger URL', { LOAD_TEST_ACK: '1', LEDGER_HTTP_URL: 'http://10.0.0.8:4001' }, false, 'ledger target'],
    ['soak flag', { LOAD_TEST_ACK: '1', LOAD_TEST_SOAK: '1' }, false, 'LOAD_TEST_SOAK'],
    ['ack + defaults', { LOAD_TEST_ACK: '1' }, true, 'plan only'],
    [
      'ack + explicit loopback',
      {
        LOAD_TEST_ACK: '1',
        MATCHING_HTTP_URL: 'http://localhost:4005',
        LEDGER_HTTP_URL: 'http://127.0.0.1:4001',
      },
      true,
      'plan only',
    ],
  ];

  let failed = 0;
  console.log('matching-ledger-load-test SELF-TEST\n');
  for (const [name, env, wantAllow, needle] of cases) {
    const got = evaluateLoadTestIntent(env);
    const ok = got.allow === wantAllow && got.reason.includes(needle);
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✖'} ${name.padEnd(28)} wantAllow=${wantAllow} got=${got.allow} (${got.reason})`);
  }
  console.log(
    failed ? `\n✖ ${failed}/${cases.length} self-test cases failed` : `\n✓ ${cases.length}/${cases.length} self-test cases passed`,
  );
  process.exit(failed ? 1 : 0);
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const decision = evaluateLoadTestIntent(env);
  if (!decision.allow) {
    console.error(`[matching-ledger-load-test] ${decision.reason}`);
    console.error('[matching-ledger-load-test] see docs/runbooks/D26-P3-03-MATCHING-LEDGER-LOAD-TEST.md');
    process.exit(decision.code);
  }
  console.log(`[matching-ledger-load-test] ${decision.reason}`);
  console.log(`[matching-ledger-load-test] matching door (description only): ${decision.matching}`);
  console.log(`[matching-ledger-load-test] ledger door (description only):   ${decision.ledger}`);
  console.log('[matching-ledger-load-test] no requests sent; doctrine §20 p99 is not a measurement from this stub');
  process.exit(0);
}

const invoked = process.argv[1] && /matching-ledger-load-test\.mjs$/.test(process.argv[1].replaceAll('\\', '/'));
if (invoked) main();
