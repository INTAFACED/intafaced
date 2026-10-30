/**
 * LOCAL TEST outside source: the stack's stand-in for the statements an outside rail publishes, served to svc-ledger's
 * reconciliation reader. It reads only the rails' own records (local-test-rail-records.mjs), never the ledger, so a run
 * compares each rail boundary with what that rail itself says.
 *
 *   GET /snapshot?asOf=<instant>               the whole outside book (LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL)
 *   GET /statement?rail=<rail>&asOf=<instant>  one rail's statement (LEDGER_RECONCILE_RAIL_<RAIL>_URL)
 *   GET /health
 *
 * A bad query or an unreadable record answers 400 or 500 with no figures, which the reader records as unavailable (ERROR),
 * never as a balance. Loopback only, local Host headers only. svc-ledger reads it only when the stack is started with
 * LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT=rails (local-stack-services/ledger.mjs). Never part of a real environment.
 */
import http from 'node:http';
import { RailRecordError, outsideSnapshot, railStatement } from './local-test-rail-records.mjs';

/** Off the services' port map, like the TEST chain's gate, so it is a stack tool rather than a stack service. */
export const OUTSIDE_SOURCE_PORT = 14534;

/** The rails whose stand-ins keep records: the TEST chain and its signer, and the TEST bank payout. */
export const OUTSIDE_SOURCE_RAILS = ['crypto-native', 'payout-sim'];

/** The answer to one request, as `{ status, body }`. */
export function answerOutside(stateDir, method, url) {
  if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
  const { pathname, searchParams } = new URL(url, 'http://local-test');
  if (pathname === '/health') return { status: 200, body: { ok: true, label: 'LOCAL TEST outside source' } };
  const asOf = searchParams.get('asOf');
  try {
    if (pathname === '/snapshot') return { status: 200, body: outsideSnapshot(stateDir, asOf ?? '') };
    if (pathname === '/statement') return { status: 200, body: railStatement(stateDir, searchParams.get('rail') ?? '', asOf ?? '') };
  } catch (err) {
    if (err instanceof RailRecordError) return { status: 400, body: { error: err.message } };
    return { status: 500, body: { error: 'the rail records could not be read' } };
  }
  return { status: 404, body: { error: 'not found' } };
}

export function serveOutsideSource({ host, port = OUTSIDE_SOURCE_PORT, stateDir }) {
  const server = http.createServer((req, res) => {
    const hostHeader = req.headers.host ?? '';
    const bound = server.address().port;
    if (hostHeader !== `${host}:${bound}` && hostHeader !== `localhost:${bound}`) {
      res.writeHead(403);
      return void res.end();
    }
    const { status, body } = answerOutside(stateDir, req.method ?? '', req.url ?? '/');
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  });
  server.on('error', (err) => {
    console.error(`outside-source: cannot listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host);
  return server;
}
