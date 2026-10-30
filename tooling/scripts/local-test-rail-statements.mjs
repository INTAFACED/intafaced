/**
 * LOCAL TEST rail statements: each stack stand-in for an outside rail answers for its own boundary, the way a real rail's
 * statement would, so svc-ledger's per-rail outside controls (LEDGER_RECONCILE_RAIL_<RAIL>_URL) compare `rail:<rail>` with
 * what that rail itself recorded (local-test-rail-records.mjs), never with the ledger read back.
 *
 * `GET /statement?rail=<rail>&asOf=<instant>` answers `{source:'rail', rail, asOf, balances}` from that rail's own records
 * at `asOf`, in the ledger's signed form. Only the rails whose stand-ins keep records are served; rail `local-test` is the
 * stack's TEST mint and has no statement. A rail it does not serve is 404, a bad query 400, and records it cannot read
 * (a line refused, a key recorded twice with other facts) 503, which the ledger records as its source unavailable, never
 * as a balance. Loopback only. Never part of a real environment.
 */
import http from 'node:http';
import { RailRecordError, railStatement } from './local-test-rail-records.mjs';

/** The rails whose stack stand-ins write their own records: the TEST chain and its signer, and the TEST bank payout. */
export const STATEMENT_RAILS = Object.freeze(['crypto-native', 'payout-sim']);

/** svc-ledger's env name for one rail's statement URL (upper case, `-` written as `_`). */
export const railStatementEnv = (rail) => `LEDGER_RECONCILE_RAIL_${rail.toUpperCase().replace(/-/g, '_')}_URL`;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

/** One request's answer: `[status, body]`. */
export function answerStatement(stateDir, method, rawUrl) {
  const url = new URL(rawUrl, 'http://local-test');
  if (method !== 'GET') return [405, { error: 'GET only' }];
  if (url.pathname === '/health') return [200, { ok: true, label: 'TEST', rails: STATEMENT_RAILS }];
  if (url.pathname !== '/statement') return [404, { error: 'no such path' }];
  const rail = url.searchParams.get('rail');
  const asOf = url.searchParams.get('asOf');
  if (!rail || !asOf) return [400, { error: 'rail and asOf are both required' }];
  if (!STATEMENT_RAILS.includes(rail)) return [404, { error: `rail ${rail} keeps no statement on this stack` }];
  if (Number.isNaN(Date.parse(asOf))) return [400, { error: `asOf "${asOf}" is not a time` }];
  try {
    return [200, railStatement(stateDir, rail, asOf)];
  } catch (err) {
    if (err instanceof RailRecordError) return [503, { error: err.message }];
    throw err;
  }
}

export function serveRailStatements({ host, port, stateDir }) {
  const server = http.createServer((req, res) => {
    try {
      const [status, body] = answerStatement(stateDir, req.method, req.url ?? '/');
      send(res, status, body);
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, host);
  return server;
}
