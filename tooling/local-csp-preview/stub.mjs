// LOCAL CSP PREVIEW: TEST-DATA stub. Not a real backend. Nothing here is real money, a real account or a real session.
//
// One process, three listeners (all on 127.0.0.1):
//   API   (default 18082)  the /api/** the customer app calls: sign-in, passkey options, markets, tickers, candles,
//                          balances, Academy rooms / sessions / videos. Every answer is invented and labelled TEST.
//   SINK  (default 18083)  receives browser CSP violation reports (report-uri) and writes one JSON line each to
//                          <state>/violations.jsonl. GET /violations returns them; POST /clear empties them.
//   LIVEKIT (default 18084) a dead-end websocket/http endpoint standing in for a LiveKit server. It accepts the TCP
//                          connection, so a browser that is ALLOWED to connect gets a protocol error, not a CSP block.
//
// Reads/writes only inside <state>. Never talks to any other port on this machine.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const env = process.env;
const STATE = env.CSP_PREVIEW_STATE ?? join(here, '.state');
const API_PORT = Number(env.CSP_PREVIEW_API_PORT ?? 18082);
const SINK_PORT = Number(env.CSP_PREVIEW_SINK_PORT ?? 18083);
const LK_PORT = Number(env.CSP_PREVIEW_LIVEKIT_PORT ?? 18084);
const STORAGE_ORIGIN = env.CSP_PREVIEW_STORAGE_ORIGIN ?? 'https://storage.csp-preview.invalid';
const LIVEKIT_URL = env.CSP_PREVIEW_LIVEKIT_URL ?? `ws://127.0.0.1:${LK_PORT}`;
mkdirSync(STATE, { recursive: true });
const VIOLATIONS = join(STATE, 'violations.jsonl');
const UNHANDLED = join(STATE, 'stub-unhandled.log');
const REQUESTS = join(STATE, 'stub-requests.log');

const fixtures = await import(pathToFileURL(join(repo, 'apps/customer/src/screens/home/home.fixtures.mjs')).href);

const USER_ID = '00000000-0000-4000-8000-00000000c5b1';
const ROOM_ID = '00000000-0000-4000-8000-0000000000a1';
const SESSION_ALLOWED = '00000000-0000-4000-8000-0000000000b1';
const SESSION_BLOCKED = '00000000-0000-4000-8000-0000000000b2';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const passkeys = []; // [{ credentialId, createdAt }] registered during this run (in memory only)

const session = () => ({
  accessToken: 'TEST-' + randomBytes(12).toString('hex'),
  refreshToken: 'TEST-' + randomBytes(12).toString('hex'),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  userId: USER_ID,
});
const sessionRow = (id, title) => ({
  id,
  roomId: ROOM_ID,
  title,
  hostId: USER_ID,
  status: 'live',
  startsAt: new Date(Date.now() - 600_000).toISOString(),
  endsAt: null,
  streamProvider: 'livekit',
  scene: {},
  sceneFingerprint: 'TEST-scene',
});
const room = {
  id: ROOM_ID,
  slug: 'test-room',
  name: 'TEST room (invented)',
  kind: 'general',
  access: 'free',
  minStake: '0',
  capacity: 50,
  hostId: USER_ID,
};

// tRPC procedures, keyed "module/procedure" -> (input, ctx) => data. Anything not listed gets a labelled 404 and is logged.
const procedures = {
  'identity/auth.login': () => session(),
  'identity/auth.register': () => session(),
  'identity/auth.refresh': () => session(),
  'identity/auth.logout': () => ({ ok: true }),
  'identity/webauthn.authOptions': () => ({
    challenge: b64url(randomBytes(32)),
    timeout: 60000,
    userVerification: 'preferred',
    ...(passkeys.length ? { allowCredentials: passkeys.map((p) => ({ id: p.credentialId, type: 'public-key' })) } : {}),
  }),
  // TEST ONLY: no signature is checked. A real service verifies the assertion; this stub accepts it so the browser-side ceremony can be exercised.
  'identity/webauthn.authVerify': () => session(),
  'identity/webauthn.registerOptions': () => ({
    challenge: b64url(randomBytes(32)),
    rp: { name: 'INTAFACED TEST (local CSP preview)' },
    user: { id: b64url(Buffer.from(USER_ID, 'utf8')), name: 'test@example.invalid', displayName: 'TEST user' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: 60000,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    attestation: 'none',
    excludeCredentials: passkeys.map((p) => ({ id: p.credentialId, type: 'public-key' })),
  }),
  'identity/webauthn.registerVerify': (input) => {
    passkeys.unshift({ credentialId: input.rawId, createdAt: new Date().toISOString() });
    return { credentialId: input.rawId };
  },
  'identity/webauthn.list': () => passkeys.map((p) => ({ credentialId: p.credentialId, createdAt: p.createdAt })),
  'academy/rooms': () => [room],
  'academy/room': () => ({
    room,
    sessions: [
      sessionRow(SESSION_ALLOWED, 'TEST live session A: media server on the allowed origin'),
      sessionRow(SESSION_BLOCKED, 'TEST live session B: media server on a NOT-allowed origin'),
    ],
  }),
  'academy/streamCredential': (input) => ({
    // Session A points at the origin CUSTOMER_LIVEKIT_ORIGIN allows locally; session B at one it must refuse.
    url: input?.sessionId === SESSION_BLOCKED ? 'wss://blocked-livekit.csp-preview.invalid' : LIVEKIT_URL,
    token: 'TEST-livekit-token',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }),
  'academy/videos': () => [
    { slug: 'allowed-origin', title: 'TEST recorded video: storage on the allowed origin', path: 'TEST' },
    { slug: 'blocked-origin', title: 'TEST recorded video: storage on a NOT-allowed origin', path: 'TEST' },
  ],
  'academy/videoPlayback': (input) => ({
    slug: input?.slug ?? 'allowed-origin',
    playbackUrl:
      input?.slug === 'blocked-origin'
        ? 'https://blocked-storage.csp-preview.invalid/test.mp4'
        : `${STORAGE_ORIGIN}/test.mp4?TEST=1`,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    grant: 'TEST-grant',
  }),
  'identity/listSessions': () => [],
  'notify/notify.unreadCount': () => ({ count: 0 }),
  'notify/notify.list': () => [],
  'academy/certDefinitions': () => [],
  'academy/seasons': () => [],
};

const restRoutes = (path, url) => {
  if (path === 'markets') return fixtures.markets;
  if (path === 'tickers') return fixtures.tickers();
  if (path === 'account/balance') return fixtures.balances();
  if (path.startsWith('ticker/')) return fixtures.tickers()[decodeURIComponent(path.slice('ticker/'.length))];
  if (path.startsWith('orderbook/')) {
    const symbol = decodeURIComponent(path.slice('orderbook/'.length));
    const last = Number(fixtures.tickers()[symbol]?.last ?? 1);
    const level = (i, dir) => [String((last + dir * (i + 1) * last * 0.0005).toFixed(4)), '0.5'];
    return {
      symbol,
      bids: Array.from({ length: 12 }, (_, i) => level(i, -1)),
      asks: Array.from({ length: 12 }, (_, i) => level(i, 1)),
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      nonce: 1,
    };
  }
  if (path === 'orders/open' || path === 'account/trades') return [];
  if (path.startsWith('ohlcv/')) return fixtures.hourlyCandles(decodeURIComponent(path.slice('ohlcv/'.length)), 200);
  return undefined;
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const send = (res, status, json, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'x-csp-preview': 'TEST-DATA-STUB', ...extra });
  res.end(JSON.stringify(json));
};
const note = (file, line) => {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* never let logging break a response */
  }
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const path = decodeURIComponent(url.pathname);
  note(REQUESTS, `${req.method} ${req.url}`);
  const body = req.method === 'GET' ? '' : await readBody(req);
  // /api/<module>/trpc/<procedure>
  const trpc = /^\/api\/([^/]+)\/trpc\/(.+)$/.exec(path);
  if (trpc) {
    const handler = procedures[`${trpc[1]}/${trpc[2]}`];
    let input;
    try {
      input = req.method === 'GET' ? JSON.parse(url.searchParams.get('input') ?? 'null') : JSON.parse(body || 'null');
    } catch {
      input = null;
    }
    if (handler) return send(res, 200, { result: { data: handler(input) } });
    note(UNHANDLED, `trpc ${req.method} ${trpc[1]}/${trpc[2]}`);
    return send(res, 404, { error: { message: `TEST STUB: ${trpc[1]}/${trpc[2]} is not stubbed`, data: { code: 'NOT_FOUND' } } });
  }
  const v1 = /^\/api\/v1\/(.+)$/.exec(path);
  if (v1) {
    const data = restRoutes(v1[1], url);
    if (data !== undefined) return send(res, 200, data);
  }
  note(UNHANDLED, `${req.method} ${req.url}`);
  send(res, 404, { error: { message: `TEST STUB: ${path} is not stubbed` } });
}).listen(API_PORT, '127.0.0.1', () => note(REQUESTS, `API stub listening ${API_PORT}`));

// CSP report sink. Browsers POST application/csp-report (report-uri) or application/reports+json (report-to).
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://sink');
  if (req.method === 'POST' && (url.pathname === '/__csp-report' || url.pathname === '/report')) {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { unparsed: raw.slice(0, 2000) };
    }
    const list = Array.isArray(parsed) ? parsed.map((r) => r.body ?? r) : [parsed['csp-report'] ?? parsed];
    // Tokens live in query strings (LiveKit access_token, presigned URLs): keep only origin + path, and cap the length.
    const bare = (v) => (typeof v === 'string' ? v.replace(/[?#].*$/, '').slice(0, 200) : v ?? null);
    for (const r of list) {
      const row = {
        at: new Date().toISOString(),
        directive: r['violated-directive'] ?? r.effectiveDirective ?? r['effective-directive'] ?? null,
        blocked: bare(r['blocked-uri'] ?? r.blockedURL ?? null),
        document: bare(r['document-uri'] ?? r.documentURL ?? null),
        source: bare(r['source-file'] ?? r.sourceFile ?? null),
        line: r['line-number'] ?? r.lineNumber ?? null,
        disposition: r.disposition ?? null,
        sample: typeof (r['script-sample'] ?? r.sample) === 'string' ? (r['script-sample'] ?? r.sample).slice(0, 80) : null,
      };
      appendFileSync(VIOLATIONS, JSON.stringify(row) + '\n');
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/violations') {
    const rows = existsSync(VIOLATIONS)
      ? readFileSync(VIOLATIONS, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    return send(res, 200, { count: rows.length, violations: rows });
  }
  if (req.method === 'POST' && url.pathname === '/clear') {
    writeFileSync(VIOLATIONS, '');
    res.writeHead(204);
    return res.end();
  }
  send(res, 404, { error: 'sink: POST /__csp-report, GET /violations, POST /clear' });
}).listen(SINK_PORT, '127.0.0.1');

// LiveKit stand-in: accepts and then closes. A CSP block never reaches this port at all.
const lk = createServer((req, res) => {
  note(REQUESTS, `livekit-stand-in ${req.method} ${req.url}`);
  send(res, 503, { error: 'TEST: this is not a LiveKit server' });
});
lk.on('upgrade', (req, socket) => {
  note(REQUESTS, `livekit-stand-in UPGRADE ${req.url}`);
  socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
});
lk.listen(LK_PORT, '127.0.0.1');
void randomUUID;
