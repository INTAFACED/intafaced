/**
 * Unit card — README refusal table stays on tip with the catalog
 * 1. Promise: README Refusal codes — every wire code is listed; no "in flight"
 *    codes that already shipped on tip
 * 2. Break: matrix omits delivery_stuck / transport_rejected while code writes them
 *    → operators and clients miss the wire vocabulary; "in flight" lies after merge
 * 3. Done bar: README table codes === allRefusalCodes(); no "In flight (open honesty"
 * 4. Class N
 * 5. Paths: services/svc-notify/**
 * 6. RED pin
 * 7. Collision: none
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allRefusalCodes } from './channel.js';

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(here, '../../README.md'), 'utf8');

function codesInReadmeTable(): string[] {
  const found = new Set<string>();
  // Table rows pad the first column: | `channel.foo`        | meaning | (`vendor.email` too)
  for (const m of readme.matchAll(/\| `((?:channel|vendor)\.[a-z0-9_]+)`\s+\|/g)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

describe('README refusal matrix pin', () => {
  it('documents every catalog code in the refusal table', () => {
    const table = new Set(codesInReadmeTable());
    const missing = allRefusalCodes().filter((c) => !table.has(c));
    expect(missing, `README table missing catalog codes: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not document free-text codes outside the catalog', () => {
    const catalog = new Set(allRefusalCodes());
    const dark = codesInReadmeTable().filter(
      (c) => !catalog.has(c as typeof allRefusalCodes extends () => readonly (infer U)[] ? U : never),
    );
    expect(dark, `README lists codes not in catalog: ${dark.join(', ')}`).toEqual([]);
  });

  it('does not claim tip codes are still "in flight" open honesty PRs', () => {
    expect(readme).not.toMatch(/In flight \(open honesty PRs, not tip yet\)/);
  });
});
