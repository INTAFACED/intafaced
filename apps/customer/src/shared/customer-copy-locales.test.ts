import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_COPY_LOCALES } from '@intafaced/i18n/locales';

// Every language some customer copy is written in (the keys of defineCopy's translations), read from the source, so a
// language gains copy only together with CUSTOMER_COPY_LOCALES, the list identity accepts for account.display.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('customer copy languages', () => {
  it('match CUSTOMER_COPY_LOCALES', () => {
    const written = new Set<string>(['en']);
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf8');
      for (const call of text.matchAll(/defineCopy\(\s*['"][^'"]+['"]\s*,\s*[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\}\s*\)/g)) {
        for (const key of call[1]!.split(',')) {
          const name = key.split(':')[0]!.trim().replace(/['"]/g, '');
          if (name) written.add(name);
        }
      }
      for (const block of text.matchAll(/^ {2}(['"]?)([a-z]{2}(?:-[A-Za-z]{2,4})?)\1: \{$/gm)) {
        if (text.includes('defineCopy(')) written.add(block[2]!);
      }
    }
    expect([...written].sort()).toEqual([...CUSTOMER_COPY_LOCALES].sort());
  });
});
