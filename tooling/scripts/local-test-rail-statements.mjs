/**
 * LOCAL TEST rail statements: each stack stand-in for an outside rail answers for its own boundary, the way a real rail's
 * statement would, so svc-ledger's per-rail outside controls (LEDGER_RECONCILE_RAIL_<RAIL>_URL) compare `rail:<rail>` with
 * what that rail itself recorded (local-test-rail-records.mjs), never with the ledger read back.
 *
 * `GET /statement?rail=<rail>&asOf=<instant>` answers `{source:'rail', rail, asOf, balances}` from that rail's own records
 * at `asOf`, in the ledger's signed form. Only the rails whose stand-ins keep records are served; rail `local-test` is the
 * stack's TEST mint and has no statement. A rail it does not serve is 404, a bad query 400, and records it cannot read
 * (a line refused, a key recorded twice with other facts) 503, which the ledger records as its source unavailable, never
 * as a balance.
 *
 * `GET /report?reporter=<venue|partner>&place=<id>&asOf=<instant>` answers the TEST venue's or TEST partner's own report of
 * our records with it for that instant (local-test-own-reports.mjs), or `reported: false` when it had published none by
 * then (svc-ledger's LEDGER_RECONCILE_REPORT_<REPORTER>_URL). Loopback only. Never part of a real environment.
 *
 * `GET /venue` and `POST /report` answer the same outside reports in the loopback outside-record shape (`venue.mjs`
 * `venueRecord`), so journey tests read the TEST venue's and TEST partner's own records directly, never through our app.
 * `POST /test/hold-report`, `GET /test/hold-report` and `POST /test/release-report` hold one `GET /report` reply in memory
 * (capped at 6 s) so a journey can observe svc-ledger's `started` run row before the outside read answers.
 */
import http from 'node:http';
import { RailRecordError, railStatement } from './local-test-rail-records.mjs';
import { OwnReportError, ownReport, REPORTERS } from './local-test-own-reports.mjs';

/** The rails whose stack stand-ins write their own records: the TEST chain and its signer, and the TEST bank payout. */
export const STATEMENT_RAILS = Object.freeze(['crypto-native', 'payout-sim']);
/** The loopback outside-record id for the TEST venue and partner reports (`venue.mjs` `venueRecord`). */
export const OWN_REPORTS_VENUE_ID = 'test-own-reports';
const PLACE_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const MAX_POST_BYTES = 64 * 1024;
/** Hard cap on a held `GET /report`, below svc-ledger's 10 s OUTSIDE_SNAPSHOT_TIMEOUT_MS so a crashed caller never hangs a run. */
const REPORT_HOLD_MAX_MS = 6_000;
const REPORT_HOLD_IDLE_MS = 30_000;

/** svc-ledger's env name for one rail's statement URL (upper case, `-` written as `_`). */
export const railStatementEnv = (rail) => `LEDGER_RECONCILE_RAIL_${rail.toUpperCase().replace(/-/g, '_')}_URL`;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function reportError(err) {
  if (err instanceof OwnReportError)
    return [/is not a time|is neither|is not a lower-case/.test(err.message) ? 400 : 503, { error: err.message }];
  throw err;
}

/** One request's answer: `[status, body]`. */
export function answerStatement(stateDir, method, rawUrl, body = null) {
  const url = new URL(rawUrl, 'http://local-test');
  if (method === 'POST' && url.pathname === '/report') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, { error: 'JSON object body required' }];
    const { account, reporter, asOf } = body;
    if (!account || typeof account !== 'object' || Array.isArray(account)) return [400, { error: 'account is required' }];
    if (account.venueId !== OWN_REPORTS_VENUE_ID) return [400, { error: `venueId must be ${OWN_REPORTS_VENUE_ID}` }];
    if (account.subAccount !== null && account.subAccount !== undefined) return [400, { error: 'subAccount must be null' }];
    if (typeof account.owner !== 'string' || !account.owner || typeof reporter !== 'string' || typeof asOf !== 'string')
      return [400, { error: 'account.owner, reporter and asOf are all required' }];
    try {
      return [200, { label: 'TEST', value: ownReport(stateDir, reporter, account.owner, asOf) }];
    } catch (err) {
      return reportError(err);
    }
  }
  if (method !== 'GET') return [405, { error: 'GET only' }];
  if (url.pathname === '/health') return [200, { ok: true, label: 'TEST', rails: STATEMENT_RAILS, reporters: REPORTERS }];
  if (url.pathname === '/venue')
    return [200, { label: 'TEST', venue: { id: OWN_REPORTS_VENUE_ID, displayName: 'TEST venue and partner reports' } }];
  if (url.pathname === '/report') {
    const [reporter, place, at] = ['reporter', 'place', 'asOf'].map((k) => url.searchParams.get(k));
    if (!reporter || !place || !at) return [400, { error: 'reporter, place and asOf are all required' }];
    try {
      return [200, ownReport(stateDir, reporter, place, at)];
    } catch (err) {
      return reportError(err);
    }
  }
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_POST_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function holdKey(reporter, place) {
  if (!REPORTERS.includes(reporter) || typeof place !== 'string' || !PLACE_RE.test(place)) return null;
  return `${reporter}:${place}`;
}

export function serveRailStatements({ host, port, stateDir, onHoldArrived = null }) {
  const holds = new Map();
  const clearHold = (key) => {
    const h = holds.get(key);
    if (!h) return false;
    holds.delete(key);
    if (h.timer) clearTimeout(h.timer);
    if (h.idle) clearTimeout(h.idle);
    h.release();
    return true;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local-test');
      if (req.method === 'GET' && url.pathname === '/test/hold-report') {
        const key = holdKey(url.searchParams.get('reporter'), url.searchParams.get('place'));
        if (!key) return send(res, 400, { error: 'valid reporter and place required' });
        const h = holds.get(key);
        return send(res, 200, { held: Boolean(h), arrived: Boolean(h?.arrived), asOf: h?.asOf ?? null });
      }
      if (req.method === 'POST' && (url.pathname === '/test/hold-report' || url.pathname === '/test/release-report')) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        const key = holdKey(body?.reporter, body?.place);
        if (!key) return send(res, 400, { error: 'valid reporter and place required' });
        if (url.pathname === '/test/release-report') return send(res, 200, { ok: true, released: clearHold(key) });
        clearHold(key);
        let release;
        const promise = new Promise((r) => {
          release = r;
        });
        const entry = { arrived: false, asOf: null, promise, release, timer: null, idle: null };
        entry.idle = setTimeout(() => clearHold(key), REPORT_HOLD_IDLE_MS);
        entry.idle.unref?.();
        holds.set(key, entry);
        return send(res, 200, { ok: true, held: true });
      }
      if (req.method === 'GET' && url.pathname === '/report') {
        const key = holdKey(url.searchParams.get('reporter'), url.searchParams.get('place'));
        const h = key ? holds.get(key) : null;
        if (h && !h.arrived) {
          h.arrived = true;
          h.asOf = url.searchParams.get('asOf');
          if (h.idle) clearTimeout(h.idle);
          h.idle = null;
          h.timer = setTimeout(() => clearHold(key), REPORT_HOLD_MAX_MS);
          h.timer.unref?.();
          onHoldArrived?.({ key, asOf: h.asOf });
          await h.promise;
        }
      }
      let body = null;
      if (req.method === 'POST' && url.pathname === '/report') {
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
      const [status, out] = answerStatement(stateDir, req.method, req.url ?? '/', body);
      send(res, status, out);
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.on('close', () => {
    for (const key of holds.keys()) clearHold(key);
  });
  server.listen(port, host);
  return server;
}
