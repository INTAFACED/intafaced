/**
 * LOCAL TEST video store: a stand-in for the S3-compatible object store svc-academy signs playback URLs for
 * (AC-videos-01). It serves a fixed set of TEST objects, and only when a request carries a valid, unexpired AWS
 * Signature V4 query signed with the stack's TEST key, so the stack exercises the same signed, short-lived URLs a real
 * store would. No upload, no listing, no other bucket. Never part of a real environment.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'local-stack-fixtures');

export const VIDEO_STORE_BUCKET = 'local-test-academy';
export const VIDEO_STORE_ACCESS_KEY = 'local-test-academy';
export const VIDEO_STORE_REGION = 'local-test';

/**
 * Object key → TEST file. The key is the one the academy spine names for its video (an owner constant); the bytes
 * are a generated 12-second TEST pattern in WebM, served with its real content type.
 */
export const VIDEO_STORE_OBJECTS = {
  'foundations/risk-first.mp4': { file: path.join(FIXTURES, 'academy-test-video.webm'), type: 'video/webm' },
};

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data) => createHash('sha256').update(data, 'utf8').digest('hex');

function awsEncode(value) {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9._~-]/.test(ch)) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function amzDateMs(amzDate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/** Why a presigned GET is refused, or null when its signature is ours and it has not expired. */
export function presignRefusal({ method, rawPath, query, host, secretKey, now = Date.now() }) {
  const signature = query.get('X-Amz-Signature') ?? '';
  const amzDate = query.get('X-Amz-Date') ?? '';
  const expires = Number(query.get('X-Amz-Expires'));
  const credential = (query.get('X-Amz-Credential') ?? '').split('/');
  if (query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || !/^[0-9a-f]{64}$/.test(signature)) return 'not signed';
  if (credential.length !== 5 || credential[0] !== VIDEO_STORE_ACCESS_KEY || credential[2] !== VIDEO_STORE_REGION)
    return 'wrong credential';
  const signedAt = amzDateMs(amzDate);
  if (!Number.isInteger(expires) || expires < 1 || Number.isNaN(signedAt)) return 'no expiry';
  if (now > signedAt + expires * 1000) return 'expired';
  const canonicalQuery = [...query.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [method, rawPath, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = credential.slice(1).join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, credential[1]), credential[2]), 's3'), 'aws4_request');
  const expected = hmac(key, stringToSign);
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : 'bad signature';
}

/** `bytes=a-b` within `size`, or null for a whole-file read; 'invalid' when it cannot be satisfied. */
function byteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Number(m[2]);
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  return start > end ? 'invalid' : { start, end };
}

export function serveVideoStore({ host, port, secretKey }) {
  const server = http.createServer((req, res) => {
    const deny = (status, why) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`LOCAL TEST video store: ${why}\n`);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'only GET and HEAD');
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    if (url.pathname === '/health') return deny(200, 'ok');
    const rawPath = (req.url ?? '/').split('?')[0];
    const prefix = `/${VIDEO_STORE_BUCKET}/`;
    const objectKey = rawPath.startsWith(prefix) ? decodeURIComponent(rawPath.slice(prefix.length)) : null;
    const object = objectKey === null ? undefined : VIDEO_STORE_OBJECTS[objectKey];
    const refusal = presignRefusal({ method: 'GET', rawPath, query: url.searchParams, host: req.headers.host ?? '', secretKey });
    if (refusal) return deny(403, refusal);
    if (!object) return deny(404, 'no such object');
    const size = fs.statSync(object.file).size;
    const range = byteRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return void res.end();
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    res.writeHead(range ? 206 : 200, {
      'content-type': object.type,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(object.file, { start, end }).pipe(res);
  });
  server.on('error', (err) => {
    console.error(`video-store: cannot listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host);
  return server;
}
