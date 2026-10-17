/**
 * A verified phone is not a sign-in factor, a recovery channel, or a step-up factor.
 * No file under src/auth may read `user_phones`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const authDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'auth');

function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('user_phones is not an auth factor', () => {
  it('no auth path reads user_phones', () => {
    const hits = typescriptFiles(authDir).filter((path) => readFileSync(path, 'utf8').includes('user_phones'));
    expect(hits).toEqual([]);
  });
});
