/**
 * Unit card — live host mounts venueIncident on /health and /ready
 * 1. Promise: M18 — halt/incident is named on the probes, not swallowed by ok:true
 * 2. Break: /health stays `{ ok, service }` so ops infer allFine from liveness
 * 3. Done bar: index.ts /health and /ready both await loadVenueIncident()
 * 4. Class N
 * 5. Paths: services/svc-notify/src/index.ts
 * 6. RED pin: venueIncident await matches only inside that app.get call
 * 7. Collision: none
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

const venueAwait = /venueIncident:\s*await loadVenueIncident\(\)/;

/** One `app.get` call. A later handler cannot satisfy this route's pin. */
function appGetCall(source: string, route: '/health' | '/ready'): string {
  const token = `app.get('${route}'`;
  const start = source.indexOf(token);
  if (start < 0) return '';
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start + 'app.get'.length; i < source.length; i += 1) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        const end = source.charAt(i + 1) === ';' ? i + 2 : i + 1;
        return source.slice(start, end);
      }
    }
  }
  return '';
}

const onlyReadyAwaits = [
  "app.get('/health', async () => ({",
  '  ok: true,',
  '}));',
  "app.get('/ready', async () => ({",
  '  ready: true,',
  '  venueIncident: await loadVenueIncident(),',
  '}));',
].join('\n');

const onlyHealthAwaits = [
  "app.get('/health', async () => ({",
  '  ok: true,',
  '  venueIncident: await loadVenueIncident(),',
  '}));',
  "app.get('/ready', async () => ({",
  '  ready: true,',
  '}));',
  'venueIncident: await loadVenueIncident()',
].join('\n');

describe('venue incident occupancy on /health and /ready', () => {
  it('live host mounts loadVenueIncident on both probes', () => {
    expect(appGetCall(indexSource, '/health')).toMatch(venueAwait);
    expect(appGetCall(indexSource, '/ready')).toMatch(venueAwait);
  });

  it('health pin fails when only /ready awaits loadVenueIncident', () => {
    expect(appGetCall(onlyReadyAwaits, '/health')).not.toMatch(venueAwait);
    expect(appGetCall(onlyReadyAwaits, '/ready')).toMatch(venueAwait);
  });

  it('ready pin fails when only /health awaits loadVenueIncident', () => {
    expect(appGetCall(onlyHealthAwaits, '/ready')).not.toMatch(venueAwait);
    expect(appGetCall(onlyHealthAwaits, '/health')).toMatch(venueAwait);
  });

  it('consumes matching GET /markets — never POST /halt-all', () => {
    expect(indexSource).toMatch(/loadMatchingVenueIncident\(\{\s*matchingUrl:\s*env\.MATCHING_URL/);
    expect(indexSource).not.toMatch(/halt-all/);
  });
});
