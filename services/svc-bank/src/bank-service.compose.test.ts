import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `bank-service.ts` stops growing (project-state #2656: 16 merged PRs in 7 days, each journey adding an import, a field
 * on `BankServices`, an option on `BankServiceOptions` and a `new …Service(` line). A new service of an area with a
 * folder of its own goes in that area's `compose.ts` (the business bank: `business/compose.ts`), which
 * `createBankServices` spreads. These caps are today's counts; they may go down, never up.
 */
const CAPS = { services: 53, options: 56, constructions: 43 } as const;
const FIX =
  "add the service to its area's compose.ts (business: src/business/compose.ts; another area: make src/<area>/compose.ts as business/compose.ts does, and spread it in createBankServices), never to bank-service.ts";

const source = readFileSync(new URL('./bank-service.ts', import.meta.url), 'utf8');

function interfaceBody(text: string, name: string): string {
  const start = text.indexOf(`export interface ${name} `);
  if (start < 0) throw new Error(`no interface ${name}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unclosed interface ${name}`);
}

/** Fields at the interface's own level, not inside a nested type or a comment. */
function topLevelFields(body: string): number {
  let depth = 0;
  let count = 0;
  for (const line of body.split('\n')) {
    if (depth === 0 && /^\s+(readonly\s+)?[A-Za-z_]\w*\??:/.test(line)) count++;
    for (const ch of line) {
      if (ch === '{' || ch === '(') depth++;
      if (ch === '}' || ch === ')') depth--;
    }
  }
  return count;
}

function composeCounts(text: string) {
  return {
    services: topLevelFields(interfaceBody(text, 'BankServices')),
    options: topLevelFields(interfaceBody(text, 'BankServiceOptions')),
    constructions: (text.match(/\bnew [A-Z]\w*\(/g) ?? []).length,
  };
}

describe('bank-service.ts stays the composition root, not the place each journey appends to', () => {
  it('declares no more services, options or constructions than today', () => {
    const counts = composeCounts(source);
    for (const key of Object.keys(CAPS) as (keyof typeof CAPS)[]) {
      expect(counts[key], `bank-service.ts ${key} is ${counts[key]}, cap ${CAPS[key]}: ${FIX}`).toBeLessThanOrEqual(CAPS[key]);
    }
  });

  it('imports no business service itself: they are composed in business/compose.ts', () => {
    const businessImports = [...source.matchAll(/^import [^;]*? from '\.\/business\/([\w-]+)\.js'/gm)].map((m) => m[1]);
    expect(
      businessImports.filter((f) => f !== 'compose' && f !== 'business-directory'),
      FIX,
    ).toEqual([]);
  });
});
