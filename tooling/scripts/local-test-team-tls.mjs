/**
 * LOCAL TEST HTTPS front for the stack's founder console (apps/admin on plain http). The Customer app's production build
 * links to the Team console only over HTTPS (apps/customer/src/app/TeamDesk.tsx), so the stack gives the link this HTTPS
 * address, with its own self-signed TEST certificate, which sends the browser on to the console instead of relaxing
 * that check. The key and certificate are made
 * per stack in its state folder (mode 600), name only 127.0.0.1 and localhost, and are never a live certificate.
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

/** Days a TEST certificate lasts; one with under a day left is made again. */
export const CERT_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

/** When a PEM certificate stops being valid, in ms since the epoch (0 when it cannot be read). */
export function certValidUntil(pem) {
  try {
    return Date.parse(new X509Certificate(pem).validTo) || 0;
  } catch {
    return 0;
  }
}

/** The state folder's TEST key and certificate for the console's HTTPS front, made with openssl when missing or expiring. */
export function ensureTestCert(dir, { now = Date.now(), run = spawnSync } = {}) {
  const key = path.join(dir, 'team-tls.key');
  const cert = path.join(dir, 'team-tls.crt');
  if (fs.existsSync(key) && fs.existsSync(cert) && certValidUntil(fs.readFileSync(cert, 'utf8')) - now > DAY_MS) return { key, cert };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      String(CERT_DAYS),
      '-subj',
      '/CN=LOCAL TEST team console',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { encoding: 'utf8' },
  );
  if (r.error || r.status !== 0) throw new Error(`team-tls: openssl could not make the TEST certificate: ${r.error?.message ?? r.stderr}`);
  fs.chmodSync(key, 0o600);
  fs.chmodSync(cert, 0o600);
  return { key, cert };
}

/**
 * An HTTPS server on host:port that sends every request on to the same path at the console's own origin (`target`) with
 * a 308. It proxies nothing: the console checks that its requests reach it on its own origin (ADMIN_ORIGIN), so the
 * founder signs in there, and this front exists only so the Customer build's HTTPS-only Team link has a real address.
 */
export function serveTeamTls({ host, port, target, key, cert }) {
  const base = new URL(target);
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const to = new URL(req.url ?? '/', base);
    if (to.origin !== base.origin) return res.writeHead(400, { 'content-type': 'text/plain' }).end('team-tls: path only\n');
    res.writeHead(308, { location: to.href, 'cache-control': 'no-store' }).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** GET `url` trusting only `certPath` as its authority: { status, location } or { status: 0 } on any failure. */
export function httpsGetTrusting(url, certPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = https.get(url, { ca: fs.readFileSync(certPath), timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
  });
}
