import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// macOS and Windows disks ignore case, so `Notices.tsx` and `notices.ts` in one folder make `./notices` resolve to either
// file there and the typecheck fails on those machines only (#5894 and the Home notices model).
const root = fileURLToPath(new URL('.', import.meta.url));

function clashes(dir: string, found: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.name.replace(/\.(tsx?|jsx?|mjs)$/, '').toLowerCase();
    const other = seen.get(key);
    if (other) found.push(`${relative(root, join(dir, other))} and ${entry.name}`);
    seen.set(key, entry.name);
    if (entry.isDirectory()) clashes(join(dir, entry.name), found);
  }
  return found;
}

describe('customer source file names', () => {
  it('has no two files or folders in one folder that a case-insensitive disk resolves to the same import', () => {
    expect(clashes(root)).toEqual([]);
  });
});
