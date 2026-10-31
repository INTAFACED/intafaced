import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { s2sFromEnv } from '@intafaced/contracts';
import { miningHealthHonesty } from './health-honesty.js';
import { createMiningRequestHandler } from './http.js';
import { createLedgerClient } from './ledger-client.js';
import { startMiningJobs } from './epoch-jobs.js';
import { edgeTrustFromProcessEnv } from './edge-trust.js';
import { listenHost } from './listen-host.js';
import { MiningError } from './errors.js';
import { readStratumTerms, startStratumDoor } from './stratum-door.js';
import { startWorkerEvaluator } from './worker-evaluator.js';

const port = Number.parseInt(process.env.HTTP_PORT ?? '4023', 10);
const ledgerUrl = process.env.LEDGER_URL?.trim();
const internalSecret = process.env.INTERNAL_SERVICE_SECRET?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const edgeSecret = process.env.EDGE_PRINCIPAL_SECRET;
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the ledger calls on the shared secret alone.
const s2s = s2sFromEnv(process.env, 'svc-mining-pool');
const ledger: (Pick<LedgerClient, 'post'> & Pick<LedgerClient, 'getTxByKey'>) | null =
  ledgerUrl && internalSecret
    ? createLedgerClient(ledgerUrl, internalSecret, s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined)
    : null;
const sql = databaseUrl
  ? postgres(databaseUrl, {
      max: 8,
      connection: { search_path: 'mining_pool,public', application_name: 'svc-mining-pool' },
      onnotice: () => undefined,
    })
  : null;

function parsePayoutIntervalMs(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return null;
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

const intervalMs = parsePayoutIntervalMs(process.env.MINING_PAYOUT_INTERVAL_MS);
const jobs = sql && ledger && intervalMs != null ? startMiningJobs({ sql, ledger, intervalMs }) : null;
// The worker evaluator has its own switch (MINING_WORKER_EVALUATE_SECONDS and MINING_WORKER_QUIET_SECONDS); it moves no
// value. Off, the log names the blank setting by its code.
const evaluator = isDirectRun() ? startWorkerEvaluator({ sql, env: process.env }) : null;
if (evaluator && 'off' in evaluator) console.error(`[workers] evaluator off: ${evaluator.off}`);

const handler = createMiningRequestHandler({
  health: () =>
    miningHealthHonesty({
      ledgerConfigured: ledger != null,
      pgConfigured: sql != null,
      jobs: [...(jobs ? jobs.host.list() : []), ...(evaluator && 'host' in evaluator ? evaluator.host.list() : [])],
    }),
  sql,
  internalSecret,
  ...(s2s.serviceVerifier && s2s.s2sMode ? { s2s: { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } } : {}),
  edgeSecret,
  edgeTrust: edgeTrustFromProcessEnv(process.env),
  ledger,
});

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.listen(port, listenHost());
  openMinerDoor();
}

/** The miner door opens only with a database and all its published terms; otherwise the log names why it stays shut. */
function openMinerDoor(): void {
  if (!sql) {
    console.error('[stratum] miner door closed: mining.pg_unavailable');
    return;
  }
  try {
    startStratumDoor({ sql, env: process.env, terms: readStratumTerms(process.env) }, listenHost()).on('error', (error) =>
      console.error('[stratum] miner door failed', error),
    );
  } catch (error) {
    if (!(error instanceof MiningError)) throw error;
    console.error(`[stratum] miner door closed: ${error.code}`);
  }
}
