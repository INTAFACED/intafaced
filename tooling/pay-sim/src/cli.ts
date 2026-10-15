import { parseOptions } from './safety.js';

if (process.argv.slice(2).join(' ') === '--help') {
  console.log('TEST DATA — no real money. Actual PayService + isolated PostgreSQL + MemoryLedger/MemoryChain.');
  console.log(
    'APP_ENV=test TEST_DATABASE_URL=<local *_test database> pnpm --filter @intafaced/pay-sim simulate [--iterations 1..100] [--timeout-ms 1..120000]',
  );
  console.log('Defaults: 1 iteration per PSP/broker/gaming TEST DATA merchant; 60000ms. Cleanup allowance: at most 10000ms.');
  console.log('At pinned base b8b8cbb2: W1 caps, W5 halts/exposure, W6 conversions and W9 screening are not built or asserted.');
} else {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  try {
    const options = parseOptions(process.argv.slice(2), process.env);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log('TEST DATA — no real money. Starting bounded sandbox run; no real keys or vendors.');
    // Ordinary expiry closes clients and finally drops the owned test DB. This
    // last-resort watchdog also bounds module startup or unexpected cleanup hangs.
    watchdog = setTimeout(() => {
      console.error('TEST DATA simulation exceeded its deadline and cleanup allowance; forced termination, no pass report.');
      process.exit(1);
    }, options.timeoutMs + 10_000);
    // The screening fixture bypass is confined to this explicitly test-only CLI.
    process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';
    const { runSimulation } = await import('./simulator.js');
    const result = await runSimulation(options, abort.signal);
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Never print the DB URL, credentials, raw argument text or driver error.
    console.error(
      'TEST DATA simulation failed. Requires APP_ENV=test, a loopback *_test PostgreSQL URL, valid finite options and successful sandbox assertions. No pass report.',
    );
    process.exitCode = 1;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
