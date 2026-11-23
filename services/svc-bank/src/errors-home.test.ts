import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANK_ERROR_STATUS } from './errors.js';

/**
 * A refusal lives with the folder that throws it (weed project-state#2733): fifteen PRs in a week each appended
 * their codes to one 1,400-line union in `errors.ts` and one status table in `router/errors.ts`. Now each folder
 * declares its codes and their caller status in its own `bank-errors.ts`; `errors.ts` only spreads the tables.
 */
const here = new URL('.', import.meta.url).pathname;
const tables = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /(^|-)bank-errors\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
  );
})(here);
const CODE_ENTRY = /^\s*(\|\s*'[a-z]+\.[a-z0-9_.]+'|'[a-z]+\.[a-z0-9_.]+'\s*:\s*'[A-Z_]+')/m;

describe('where a svc-bank refusal is declared', () => {
  it('errors.ts and router/errors.ts declare no code: it goes in the throwing folder’s bank-errors.ts', () => {
    for (const file of ['errors.ts', 'router/errors.ts']) {
      expect(readFileSync(join(here, file), 'utf8').match(CODE_ENTRY)?.[0] ?? null, file).toBeNull();
    }
  });

  it('every folder table is spread into BANK_ERROR_STATUS, and no code is declared twice', () => {
    const seen = new Map<string, string>();
    const index = readFileSync(join(here, 'errors.ts'), 'utf8');
    for (const file of tables) {
      const text = readFileSync(file, 'utf8');
      const name = text.match(/export const (\w+_BANK_ERRORS) = \{/)?.[1];
      expect(name, file).toBeTruthy();
      expect(index, `${file} is not spread in errors.ts`).toContain(`...${name},`);
      for (const [, code] of text.matchAll(/^\s*'([a-z]+\.[a-z0-9_.]+)'\s*:/gm)) {
        expect(seen.get(code!), `${code} is declared in ${seen.get(code!)} and ${file}`).toBeUndefined();
        seen.set(code!, file);
      }
    }
    expect([...seen.keys()].sort()).toEqual(Object.keys(BANK_ERROR_STATUS).sort());
  });
});
