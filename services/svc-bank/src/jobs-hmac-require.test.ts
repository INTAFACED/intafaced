/**
 * HTTP JobHost mutate doors bind HMAC to retained bytes (`mode: 'require'`).
 * Compose INTERNAL_SERVICE_BODY_BIND stays accept-both — do not mill that pin.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { requireInternalJobHmac } from './internal-job-hmac.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const SECRET = 'a'.repeat(32);
const BODY = '{"limit":1}';

const JOBS = [
  'run-due-transfers',
  'accrue-interest',
  'accrue-loan-interest',
  'run-risk-sweep',
  'resume-pending-loans',
  'resume-pending-earn',
  'run-auto-invest',
] as const;

function requireServiceSlice(index: string): string {
  const start = index.indexOf('function requireService');
  expect(start).toBeGreaterThan(-1);
  const end = index.indexOf('\nfunction ', start + 1);
  expect(end).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('svc-bank HTTP job HMAC require', () => {
  it('production requireService hardcodes mode require — not compose INTERNAL_SERVICE_BODY_BIND', () => {
    const index = readFileSync(join(DIR, 'index.ts'), 'utf8');
    const mill = readFileSync(join(DIR, 'internal-job-hmac.ts'), 'utf8');
    const slice = requireServiceSlice(index);
    expect(slice).toMatch(/requireInternalJobHmac/);
    expect(slice).not.toMatch(/env\.INTERNAL_SERVICE_BODY_BIND/);
    expect(mill).toMatch(/mode:\s*'require'/);
    expect(mill).not.toMatch(/mode:\s*env\.INTERNAL_SERVICE_BODY_BIND/);
    expect(index).toMatch(/retainRawBody\(app\)/);
    for (const job of JOBS) {
      const marker = `app.post('/internal/jobs/${job}'`;
      const at = index.indexOf(marker);
      expect(at, job).toBeGreaterThan(-1);
      const next = index.indexOf("app.post('/internal/jobs/", at + marker.length);
      const trpc = index.indexOf('await app.register(fastifyTRPCPlugin', at);
      const end = next === -1 ? trpc : Math.min(next, trpc);
      const route = index.slice(at, end);
      expect(route, job).toMatch(/if \(!requireService\(req\)\)/);
    }
    const ctxStart = index.indexOf('createContext: ({ req })');
    expect(ctxStart).toBeGreaterThan(-1);
    const ctx = index.slice(ctxStart, ctxStart + 800);
    expect(ctx).toMatch(/bodyBindMode:\s*env\.INTERNAL_SERVICE_BODY_BIND/);
  });

  it('v1 HMAC is rejected even when bytes are retained — require does not fall back to accept-both', () => {
    const headers = serviceAuthHeaders('svc-cron', SECRET);
    const retained = { retained: true as const, bytes: Buffer.from(BODY) };
    expect(requireInternalJobHmac(headers, SECRET, retained)).toBe(false);
    expect(requireInternalJobHmac(headers, SECRET, { retained: false })).toBe(false);
  });

  it('v2 HMAC matching retained bytes is accepted', () => {
    const headers = serviceAuthHeadersForBody('svc-cron', SECRET, BODY);
    expect(requireInternalJobHmac(headers, SECRET, { retained: true, bytes: Buffer.from(BODY) })).toBe(true);
  });

  it('v2 HMAC mismatched retained bytes is rejected', () => {
    const headers = serviceAuthHeadersForBody('svc-cron', SECRET, BODY);
    expect(requireInternalJobHmac(headers, SECRET, { retained: true, bytes: Buffer.from('{"limit":99}') })).toBe(false);
  });

  it('unsigned is rejected', () => {
    expect(requireInternalJobHmac({ 'content-type': 'application/json' }, SECRET, { retained: true, bytes: Buffer.from(BODY) })).toBe(
      false,
    );
  });
});
