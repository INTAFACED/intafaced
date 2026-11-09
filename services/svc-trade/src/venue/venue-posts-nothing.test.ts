import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * J-wallet-09's money line: "INTAFACED moves nothing and the ledger posts nothing: the deposit into the venue and the
 * withdrawal back are the user's own signed venue transfers". The user-venue door and the TEST venue behind it reach
 * no ledger recipe, no ledger client and no event bus: the only thing they take from the ledger package is the
 * `Amount` type and its pure decimal helpers (`@intafaced/ledger-client/money`). A later change that wires a posting
 * into a deposit or withdrawal fails here first. (The running app's check is the journey's: the person's ledger
 * balances read the same before and after #3 and #5.)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [here, path.resolve(here, '../../../../packages/venue-sim/src')];

const sources = roots.flatMap((root) =>
  readdirSync(root)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: path.join(root, f), text: readFileSync(path.join(root, f), 'utf8') })),
);

/** Every module a source imports. */
const imports = (text: string) =>
  [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]!);

/** What a venue path may take from the ledger package: the money type and its pure helpers, nothing that posts. */
const LEDGER_ALLOWED = new Set(['@intafaced/ledger-client/money']);
const POSTS = [/ledger-client/, /\/ledger\b/, /events?(\.js)?$/, /nats/, /outbox/];

describe('the venue door and the TEST venue post nothing to the ledger (J-wallet-09)', () => {
  it('reads every source it guards', () => {
    expect(sources.map((s) => path.basename(s.file))).toEqual(
      expect.arrayContaining(['user-venue-door.ts', 'user-venue-rest.ts', 'http-user-venue.ts', 'simulator.ts', 'chain-deposits.ts']),
    );
  });

  it('imports no ledger client, recipe or event bus: only the Amount type and its pure helpers', () => {
    const reached = sources.flatMap((s) =>
      imports(s.text)
        .filter((m) => !LEDGER_ALLOWED.has(m) && POSTS.some((re) => re.test(m)))
        .map((m) => `${path.basename(s.file)} → ${m}`),
    );
    expect(reached).toEqual([]);
  });

  it('a planted ledger import is caught (the guard is not blind)', () => {
    const planted = `import { postEntries } from '@intafaced/ledger-client';\nimport { publish } from '../events.js';`;
    expect(imports(planted).filter((m) => !LEDGER_ALLOWED.has(m) && POSTS.some((re) => re.test(m)))).toEqual([
      '@intafaced/ledger-client',
      '../events.js',
    ]);
  });
});
