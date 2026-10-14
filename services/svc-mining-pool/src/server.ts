import { createServer } from 'node:http';
import postgres from 'postgres';
import { miningHealthHonesty } from './health-honesty.js';
import { createLedgerClient } from './ledger-client.js';
import { startMiningJobs } from './epoch-jobs.js';
import { loadMiningPoolDatabase } from './pool-config.js';
import { handleSubmitSharePost } from './submit-share.js';

const port = Number.parseInt(process.env.HTTP_PORT ?? '4023', 10);
const ledgerUrl = process.env.LEDGER_URL?.trim();
const internalSecret = process.env.INTERNAL_SERVICE_SECRET?.trim();
const database = loadMiningPoolDatabase();
const ledger = ledgerUrl && internalSecret ? createLedgerClient(ledgerUrl, internalSecret) : null;
const sql = database
  ? postgres(database.url, {
      max: database.max,
      ssl: database.ssl ? 'require' : false,
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

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function rawBodyOf(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  if (request.url === '/health' || request.url === '/ready') {
    json(
      response,
      200,
      miningHealthHonesty({
        ledgerConfigured: ledger != null,
        pgConfigured: sql != null,
        jobs: jobs ? jobs.host.list() : [],
      }),
    );
    return;
  }
  if (request.method === 'POST' && request.url === '/submitShare') {
    const rawBody = await rawBodyOf(request);
    const result = await handleSubmitSharePost({
      headers: request.headers,
      rawBody,
      secret: internalSecret,
      sql,
    });
    json(response, result.status, result.body);
    return;
  }
  json(response, 404, { error: 'mining.route_unavailable' });
});

server.listen(port, '0.0.0.0');
