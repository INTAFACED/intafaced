import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { miningHealthHonesty } from './health-honesty.js';
import { createMiningRequestHandler } from './http.js';
import { createLedgerClient } from './ledger-client.js';
import { startMiningJobs } from './epoch-jobs.js';

const port = Number.parseInt(process.env.HTTP_PORT ?? '4023', 10);
const ledgerUrl = process.env.LEDGER_URL?.trim();
const internalSecret = process.env.INTERNAL_SERVICE_SECRET?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const edgeSecret = process.env.EDGE_PRINCIPAL_PUBLIC_KEY ?? process.env.EDGE_PRINCIPAL_SECRET;
const ledger: (Pick<LedgerClient, 'post'> & Pick<LedgerClient, 'getTxByKey'>) | null =
  ledgerUrl && internalSecret ? createLedgerClient(ledgerUrl, internalSecret) : null;
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

const handler = createMiningRequestHandler({
  health: () =>
    miningHealthHonesty({
      ledgerConfigured: ledger != null,
      pgConfigured: sql != null,
      jobs: jobs ? jobs.host.list() : [],
    }),
  sql,
  internalSecret,
  edgeSecret,
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
  server.listen(port, '0.0.0.0');
}
