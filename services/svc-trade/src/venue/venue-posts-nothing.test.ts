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
 * balances read the same before and after #3 and #5.) It reads each guarded file's own imports, not what they import in
 * turn: the journey's before-and-after ledger read is the check that covers everything reached.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [here, path.resolve(here, '../../../../packages/venue-sim/src')];

const sources = roots.flatMap((root) =>
  readdirSync(root)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: path.join(root, f), text: readFileSync(path.join(root, f), 'utf8') })),
);

/**
 * Every module a source imports at run time. A whole-statement `import type` / `export type` is erased when it compiles,
 * so it reaches nothing and posts nothing (venue-listing.ts names the `EventBus` type for its own operator events); a
 * value import of the same module still counts.
 */
const imports = (text: string) =>
  [
    ...text
      .replace(/\b(?:import|export)\s+type\s+(?:\{[^}]*\}|[\w*\s,]+)\s+from\s+['"][^'"]+['"]/g, '')
      .matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1] ?? m[2]!);

/** What a venue path may take from the ledger package: the money type and its pure helpers, nothing that posts. */
const LEDGER_ALLOWED = new Set(['@intafaced/ledger-client/money']);
const POSTS = [/ledger-client/, /\/ledger\b/, /events?(\.js)?$/, /nats/, /outbox/];

/**
 * What a builder reads when this fails: the file to edit and the rule. A venue path never posts to the ledger or
 * publishes an event; code that does (a builder-fee posting, an operator event) lives in its own folder outside
 * `services/svc-trade/src/venue/` and `packages/venue-sim/src/` (as `src/builder-fee/` does) and reaches the ledger only
 * through `@intafaced/ledger-client` recipes. Move the import or the file; never widen LEDGER_ALLOWED or POSTS here.
 */
const FIX =
  'A venue door or TEST venue file imports something that can post to the ledger or publish an event (J-wallet-09: the venue paths post nothing). ' +
  'Edit the file named before the arrow: move the posting code to its own folder outside services/svc-trade/src/venue/ and packages/venue-sim/src/ ' +
  '(as src/builder-fee/ does), or import only the type (`import type`) or `@intafaced/ledger-client/money`. Do not widen this test.';
const MOVED =
  'A guarded venue file was renamed or moved out of services/svc-trade/src/venue/ or packages/venue-sim/src/: keep it there, or add its new folder to `roots` above so it stays guarded.';

describe('the venue door and the TEST venue post nothing to the ledger (J-wallet-09)', () => {
  it('reads every source it guards', () => {
    expect(
      sources.map((s) => path.basename(s.file)),
      MOVED,
    ).toEqual(
      expect.arrayContaining(['user-venue-door.ts', 'user-venue-rest.ts', 'http-user-venue.ts', 'simulator.ts', 'chain-deposits.ts']),
    );
  });

  it('imports no ledger client, recipe or event bus: only the Amount type and its pure helpers', () => {
    const reached = sources.flatMap((s) =>
      imports(s.text)
        .filter((m) => !m.startsWith('node:') && !LEDGER_ALLOWED.has(m) && POSTS.some((re) => re.test(m)))
        .map((m) => `${path.basename(s.file)} → ${m}`),
    );
    expect(reached, FIX).toEqual([]);
  });

  it('a planted ledger import is caught (the guard is not blind)', () => {
    const planted = `import { postEntries } from '@intafaced/ledger-client';\nimport { publish } from '../events.js';`;
    expect(imports(planted).filter((m) => !LEDGER_ALLOWED.has(m) && POSTS.some((re) => re.test(m)))).toEqual([
      '@intafaced/ledger-client',
      '../events.js',
    ]);
  });

  it('a type-only import of the event bus reaches nothing; a value import of it is caught', () => {
    expect(imports(`import type { EventBus } from '@intafaced/events';`)).toEqual([]);
    expect(imports(`import { type EventBus, publish } from '@intafaced/events';`)).toEqual(['@intafaced/events']);
    expect(imports(`import { createBus } from '@intafaced/events';`)).toEqual(['@intafaced/events']);
  });
});
