import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN } from '../../../tooling/ci/brand-scan.mjs';

/**
 * THE COPY-SCAN, FROM THE INSIDE (§7.2, Doctrine §0.7).
 *
 *   "The onboarding intelligence is the … Neural Engine consumed as an internal
 *    service. User-facing copy references only: Identity Blueprint, Sovereign
 *    Intelligence, Neural Engine. No third-party system names anywhere in UI,
 *    API responses, or docs shipped to users."
 *
 * §7.2 makes an automated copy-scan an exit criterion. `pnpm scan:brand` runs
 * repo-wide in CI; this test runs the same rule against this package as part of
 * its own suite, so a violation fails the service's tests rather than waiting
 * for a separate CI step someone can be tempted to skip.
 *
 * ── Why it reads the scanner instead of listing names ───────────────────────
 * The vocabulary is imported from `tooling/ci/brand-scan.mjs` (its `FORBIDDEN`), not
 * duplicated here. Two reasons, and the second is the real one:
 *
 *   1. A name added to the scanner is enforced here immediately, with no second
 *      list to remember to update.
 *
 *   2. **This file does not contain a single forbidden name.** A test that
 *      hard-coded the vendor names to search for would itself be a file
 *      containing them — in the one package where §0.7 says they must never
 *      appear, and in a file the repo-wide scanner also reads. The test would
 *      fail the rule it exists to enforce.
 *
 * ── Why it is stricter than the repo scan ───────────────────────────────────
 * `brand-scan.mjs` skips `drizzle/` directories and does not scan `.sql`. This
 * package's migrations are prose-heavy and are exactly where an engineer would
 * naturally write the vendor's name while explaining what the engine is. So
 * this test scans them too.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoRoot = join(packageRoot, '..', '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.sql', '.yaml', '.yml'];

/** The scanner's own patterns, imported: importing it scans nothing (it scans only when run as a script). */
function forbiddenPatterns(): RegExp[] {
  return FORBIDDEN.map(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace('g', '')));
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.some((ext) => name.endsWith(ext))) yield full;
  }
}

describe('§7.2 copy-scan — Doctrine §0.7 branding', () => {
  const patterns = forbiddenPatterns();

  it('extracts a non-empty vocabulary from the scanner', () => {
    // Guards the whole file: without this, a failed extraction would make every
    // assertion below trivially true.
    expect(patterns.length).toBeGreaterThan(5);
  });

  it('contains no forbidden name in any file in this package', () => {
    const violations: string[] = [];

    for (const file of walk(packageRoot)) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        if (!pattern.test(content)) continue;
        content.split('\n').forEach((line, index) => {
          if (new RegExp(pattern.source, pattern.flags).test(line)) {
            violations.push(`${relative(repoRoot, file)}:${index + 1}`);
          }
        });
      }
    }

    // Code, comments, tests, fixtures and migrations alike. This service is the
    // one place someone would naturally type the engine's vendor name while
    // explaining what the engine is, which is precisely why it is barred here
    // rather than merely barred from shipped copy.
    expect(violations).toEqual([]);
  });

  it('scans a meaningful number of files, including the migrations', () => {
    const scanned = [...walk(packageRoot)].map((f) => relative(packageRoot, f));

    expect(scanned.length).toBeGreaterThan(10);
    expect(scanned.some((f) => f.endsWith('.sql'))).toBe(true);
    expect(scanned.some((f) => f === 'README.md')).toBe(true);
  });

  it('would catch a forbidden name if one were introduced', () => {
    // A negative control. Without it, a bug in `forbiddenPatterns` or `walk`
    // would make the assertion above pass on an empty search and nobody would
    // know. The offending string is assembled at runtime from character codes,
    // so this file still contains no forbidden name to find.
    const assembled = [71, 77, 97, 115, 116, 101, 114].map((c) => String.fromCharCode(c)).join('');
    const matched = patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(`the ${assembled} engine`));

    expect(matched).toBe(true);
  });

  it('uses the approved vocabulary in its own documentation', () => {
    const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');

    // §0.7 names exactly three things user-facing copy may say. The README is
    // the service's contract with the rest of the repo, and it should model the
    // vocabulary rather than merely avoid the forbidden one.
    expect(readme).toContain('Identity Blueprint');
    expect(readme).toContain('Neural Engine');
    expect(readme).toContain('Sovereign Intelligence');
  });
});
