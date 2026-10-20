/**
 * New customer files take their response types from `@intafaced/contracts` (see `apps/customer/README.md`).
 *
 * This looks only at files this branch ADDS against the merge base with `origin/main`, so no existing file can trip it and
 * a service PR is never held by it. A new file that declares response schemas by hand fails here unless it either imports
 * from `@intafaced/contracts` (derive or narrow the contract's schema) or says why no contract exists yet:
 *
 *   // hand-declared-ok: svc-foo has no browser-safe schema in packages/contracts yet
 *
 * Cost: one `git merge-base` and one `git diff --name-only`, about 50 ms, plus a read of the few files a PR adds.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url).pathname;
const SCOPE = 'apps/customer/src/';

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const DECLARES = /\bz\s*\.\s*(object|discriminatedUnion)\s*\(/;
const CALLS_API = /\.(query|mutate|rest|scopedRest|plain)\s*(<[^>]*>)?\(|\bApiClient\b|\bApiResult\b|shared\/api['"]/;
const NAMED_AS_API_FILE = /(^|[-./])(schemas?|api)\.tsx?$/;
const FROM_CONTRACTS = /from\s+['"]@intafaced\/contracts(\/[a-z0-9-]+)?['"]/;
const EXEMPT = /hand-declared-ok:[ \t]*\S[^\n]{8,}/;

/** The reason a new file is a hand-declared response schema, or null when it is fine. */
export function handSchemaProblem(path: string, text: string): string | null {
  if (!path.startsWith(SCOPE) || !/\.tsx?$/.test(path) || /\.d\.ts$|\.test\.tsx?$|\.spec\.tsx?$|__fixtures__\//.test(path)) return null;
  if (EXEMPT.test(text)) return null;
  const code = stripComments(text);
  if (!DECLARES.test(code)) return null;
  if (!(CALLS_API.test(code) || NAMED_AS_API_FILE.test(path))) return null;
  if (FROM_CONTRACTS.test(code)) return null;
  return 'declares z.object schemas for a service answer without importing from @intafaced/contracts';
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Files this branch adds against the merge base: committed, staged or untracked. Renames and moves are not additions. */
function addedFiles(): string[] | null {
  const base = git(['merge-base', 'HEAD', 'origin/main']);
  if (!base) return null;
  const added = git(['diff', '--diff-filter=A', '-M', '--name-only', base, '--', SCOPE]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', SCOPE]);
  if (added === null || untracked === null) return null;
  return [...new Set([...added.split('\n'), ...untracked.split('\n')].filter(Boolean))];
}

describe('new customer files do not declare response schemas by hand', () => {
  it('holds for every file this branch adds', () => {
    const files = addedFiles();
    if (files === null) {
      // No merge base to compare with (a shallow clone, a source archive, a checkout without origin/main). Skipping is the
      // safe answer: failing here would stop a pull request for a reason that is not in its files.
      console.warn('no-new-hand-schemas: no origin/main merge base, check skipped');
      return;
    }
    const problems = files.flatMap((path) => {
      const problem = handSchemaProblem(path, readFileSync(repoRoot + path, 'utf8'));
      return problem ? [`${path}: ${problem}`] : [];
    });
    expect(
      problems,
      'New screens take their types from @intafaced/contracts (apps/customer/README.md). Import the contract schema and narrow it, ' +
        'or, if the service has no browser-safe schema yet, add `// hand-declared-ok: <what is missing>` to the file.',
    ).toEqual([]);
  });

  describe('the rule', () => {
    const screen = `import { z } from 'zod';\nconst s = z.object({ a: z.string() });\nexport const read = (api) => api.query('x', 'y', undefined, s);\n`;
    it('flags a new file that declares a schema and calls the service', () => {
      expect(handSchemaProblem('apps/customer/src/features/x/api.ts', screen)).not.toBeNull();
      expect(
        handSchemaProblem('apps/customer/src/features/x/schemas.ts', `import { z } from 'zod';\nexport const a = z.object({});\n`),
      ).not.toBeNull();
    });
    it('lets a file derive from the contracts, or give a reason', () => {
      expect(
        handSchemaProblem(
          'apps/customer/src/features/x/api.ts',
          `import { rankStateSchema } from '@intafaced/contracts/identity';\n${screen}`,
        ),
      ).toBeNull();
      expect(
        handSchemaProblem(
          'apps/customer/src/features/x/api.ts',
          `// hand-declared-ok: svc-x has no schema in packages/contracts\n${screen}`,
        ),
      ).toBeNull();
      expect(handSchemaProblem('apps/customer/src/features/x/api.ts', `// hand-declared-ok:\n${screen}`)).not.toBeNull();
    });
    it('leaves alone what is not a response schema', () => {
      const form = `import { z } from 'zod';\nexport const draft = z.object({ note: z.string() });\n`;
      expect(handSchemaProblem('apps/customer/src/features/x/draft.ts', form)).toBeNull();
      expect(handSchemaProblem('apps/customer/src/features/x/api.test.ts', screen)).toBeNull();
      expect(handSchemaProblem('apps/admin/src/api.ts', screen)).toBeNull();
      expect(
        handSchemaProblem('apps/customer/src/features/x/api.ts', `// z.object({}) in a comment only\nexport const a = 1;\n`),
      ).toBeNull();
    });
  });
});
