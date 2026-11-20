import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A test file in this service gets its own database: `createTestDatabase` from `@intafaced/db`, made from the
 * migrations and dropped after (src/own/automation.test.ts shows it). The shared `intafaced_test` agents schema,
 * serialised by advisory lock 842671, leaks one file's rows into the next: spend/store.test.ts's leftover spend limit
 * refused every run in automation.test.ts and lost pushes on three PRs (#8305; project-state #2615).
 *
 * SHARED lists the files still on the shared schema. It only shrinks: a new file on it fails here, and a listed file
 * moved to its own database fails until it is taken off the list.
 */
const SHARED = [
  'alerts/alerts.db.test.ts',
  'coach/coach-run.db.test.ts',
  'fleet/control.db.test.ts',
  'gateway/route-changes.db.test.ts',
  'metering/partner-payment.money.test.ts',
  'navigator/onchain-routes.db.test.ts',
  'own/access.test.ts',
  'own/dry-run.test.ts',
  'own/evaluations.test.ts',
  'own/guardrails.test.ts',
  'own/identity.test.ts',
  'own/memory.test.ts',
  'own/payment-method.test.ts',
  'own/policy.test.ts',
  'own/publishing.test.ts',
  'own/run.test.ts',
  'own/store.test.ts',
  'own/unpaid.test.ts',
  'own/usage-day.test.ts',
  'own/usage-limits.test.ts',
  'review/review.db.test.ts',
  'runs/background.db.test.ts',
  'runs/runs.db.test.ts',
  'runtime.test.ts',
  'spend/store.test.ts',
  'team/runs.test.ts',
  'team/store.test.ts',
];

/** The shared schema's marks: its lock, or a connection whose search_path is the agents schema. */
const SHARED_MARK = /pg_advisory_lock\(842671\)|search_path:\s*['"`]agents\b/;

const src = dirname(fileURLToPath(import.meta.url));
const testFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name)) : /\.test\.[cm]?ts$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/** The files on the shared schema that SHARED does not list, and the listed files no longer on it. */
export function sharedDatabaseDrift(files: ReadonlyMap<string, string>, listed: readonly string[]) {
  const onShared = [...files].filter(([, text]) => SHARED_MARK.test(text)).map(([name]) => name);
  return {
    unlisted: onShared.filter((f) => !listed.includes(f)).sort(),
    moved: listed.filter((f) => !onShared.includes(f)).sort(),
  };
}

describe('every svc-agents test file has its own database', () => {
  const self = fileURLToPath(import.meta.url);
  const files = new Map(
    testFiles(src)
      .filter((f) => f !== self)
      .map((f) => [relative(src, f), readFileSync(f, 'utf8')]),
  );

  it('no file outside the shrinking list uses the shared intafaced_test schema: use createTestDatabase', () => {
    expect(sharedDatabaseDrift(files, SHARED).unlisted).toEqual([]);
  });

  it('a listed file moved to its own database is taken off the list', () => {
    expect(sharedDatabaseDrift(files, SHARED).moved).toEqual([]);
  });

  it('catches the past mistake: automation.test.ts on the shared schema, as it was before #2615', () => {
    const before = `await lockConn\`select pg_advisory_lock(842671)\`;\nconnection: { search_path: 'agents,public' }`;
    expect(sharedDatabaseDrift(new Map([['own/automation.test.ts', before]]), SHARED).unlisted).toEqual(['own/automation.test.ts']);
  });
});
