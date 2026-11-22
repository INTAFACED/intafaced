import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COPY_KEYS,
  EN,
  isCopyKey,
  render,
  copyKeyCount,
  refusedCopyKeys,
  copyCatalogBoardCard,
  parseCopyCatalogStatusLine,
  copyCatalogStatusLineMatches,
  copyCatalogEnComplete,
  copyCatalogExportHeader,
  copyCatalogExportLines,
  copyCatalogExportText,
  copyKeyCountInRange,
} from './copy.js';

/**
 * DOCTRINE §0.7, ASSERTED FROM INSIDE THE PACKAGE.
 *
 *   "No third-party system names anywhere in UI, API responses, or docs shipped
 *    to users."
 *
 * `tooling/ci/brand-scan.mjs` enforces this across the repo. This test enforces
 * the same rule from within svc-agents, for two reasons:
 *
 *   1. This is the one service whose whole job is to talk to a third-party
 *      system. The rule is most likely to be broken here, and the feedback loop
 *      of `vitest` is seconds where the CI gate is minutes.
 *   2. It is a design assertion, not just a lint: it proves the *architecture*
 *      keeps vendor names out — provider ids, model aliases and endpoints are
 *      all configuration — rather than relying on everyone remembering.
 *
 * ── Why the names below are spelled in pieces ───────────────────────────────
 *
 * This file is scanned by `brand-scan` like every other file. Writing the
 * forbidden names out would make the test that enforces the rule the thing that
 * breaks it. Splitting each literal defeats the `\b…\b` patterns while keeping
 * the check exact — and is strictly better than adding this file to the
 * scanner's allowlist, which would carve a permanent hole in the rule to test
 * the rule.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(here, '..');

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: new RegExp(`\\b${'Anthrop' + 'ic'}\\b`, 'i'), what: 'model provider' },
  { pattern: new RegExp(`\\b${'Cla' + 'ude'}\\b`, 'i'), what: 'model provider' },
  { pattern: new RegExp(`\\b${'Open' + 'AI'}\\b`, 'i'), what: 'model provider' },
  { pattern: new RegExp(`\\b${'GP' + 'T'}-\\d`, 'i'), what: 'model provider' },
  { pattern: new RegExp(`\\b${'GMas' + 'ter'}\\b`, 'i'), what: 'engine vendor' },
  { pattern: new RegExp(`\\b${'Finc' + 'ept'}\\b`, 'i'), what: 'terminal vendor' },
  { pattern: new RegExp(`\\b${'Settle' + 'TX'}\\b`, 'i'), what: 'rail partner' },
  { pattern: new RegExp(`\\b${'PayK' + 'wik'}\\b`, 'i'), what: 'rail partner' },
  { pattern: new RegExp(`\\b${'NT' + 'G'}\\b`), what: 'rail partner' },
];

/** The only vocabulary permitted in user-facing copy. */
const PERMITTED = ['Sovereign Intelligence', 'Neural Engine', 'Identity Blueprint'];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.sql'];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.some((ext) => name.endsWith(ext))) yield full;
  }
}

function offences(content: string): string[] {
  const found: string[] = [];
  for (const line of content.split('\n')) {
    for (const { pattern, what } of FORBIDDEN) {
      if (pattern.test(line)) found.push(`${what}: ${line.trim().slice(0, 100)}`);
    }
  }
  return found;
}

describe('doctrine §0.7 — the branding law', () => {
  it('names no third-party system in the user-facing copy catalogue', () => {
    for (const key of COPY_KEYS) {
      expect(offences(EN[key]), `copy key "${key}"`).toEqual([]);
    }
  });

  it('names no third-party system anywhere in the package', () => {
    // Deliberately the WHOLE package, not just `copy.ts`: an internal comment
    // naming a vendor would be no less of a leak the moment someone pastes it
    // into an error message, and the doctrine is easier to keep when it has no
    // exceptions to remember.
    const violations: string[] = [];

    for (const file of walk(PACKAGE_ROOT)) {
      const found = offences(readFileSync(file, 'utf8'));
      for (const offence of found) violations.push(`${relative(PACKAGE_ROOT, file)} — ${offence}`);
    }

    expect(violations).toEqual([]);
  });

  it('actually uses the vocabulary the doctrine mandates', () => {
    // The inverse assertion. A catalogue could pass the scan by never referring
    // to the intelligence at all, which would satisfy the letter of §0.7 and
    // none of its point.
    const all = COPY_KEYS.map((k) => EN[k]).join(' ');
    expect(PERMITTED.some((term) => all.includes(term))).toBe(true);
  });

  it('proves the check would catch a violation', () => {
    // A scanner nobody has seen fail is a scanner nobody should trust.
    const planted = `The ${'Cla' + 'ude'} model answered.`;
    expect(offences(planted)).toHaveLength(1);
  });
});

describe('copy catalogue', () => {
  it('has an entry for every declared key', () => {
    for (const key of COPY_KEYS) {
      expect(EN[key], key).toBeTruthy();
    }
    expect(Object.keys(EN).sort()).toEqual([...COPY_KEYS].sort());
  });

  it('recognises its own keys and rejects anything else', () => {
    expect(isCopyKey('agents.session.opened')).toBe(true);
    expect(isCopyKey('agents.session.exploded')).toBe(false);
  });

  it('substitutes parameters and leaves unknown placeholders visible', () => {
    expect(render('agents.refused.tool_not_declared', { tool: 'bank.withdraw' })).toContain('bank.withdraw');
    // A missing parameter must not silently render as "undefined": a log line
    // reading "already used undefined time(s)" is worse than an obvious hole.
    expect(render('agents.refused.tool_call_limit', { tool: 'x' })).toContain('{limit}');
  });

  it('explains every refusal — a refusal with no reason is indistinguishable from a fault', () => {
    const refusals = COPY_KEYS.filter((k) => k.startsWith('agents.refused.'));
    expect(refusals.length).toBeGreaterThan(0);
    for (const key of refusals) {
      expect(EN[key].length, key).toBeGreaterThan(20);
    }
  });
});

describe('L3 wave62 copy catalog honesty', () => {
  it('catalog boards and EN coverage', () => {
    expect(copyKeyCount()).toBe(COPY_KEYS.length);
    expect(refusedCopyKeys().every((k) => k.startsWith('agents.refused.'))).toBe(true);
    expect(copyCatalogBoardCard().total).toBe(COPY_KEYS.length);
    expect(copyCatalogEnComplete()).toBe(true);
    expect(copyCatalogStatusLineMatches()).toBe(true);
    expect(parseCopyCatalogStatusLine('nope')).toBeNull();
    expect(copyCatalogExportText().startsWith(copyCatalogExportHeader())).toBe(true);
    expect(copyCatalogExportLines()).toHaveLength(COPY_KEYS.length);
    expect(copyKeyCountInRange(1, 500)).toBe(true);
    expect(copyKeyCountInRange(500, 1)).toBe(false);
  });
});
