import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * svc-pay posts to the ledger only through `postPayLedger`
 * (`ledger-receipt.ts`), which refuses a receipt that does not match its
 * request. A bare `ledger.post(` elsewhere takes any receipt as booked.
 * Narrowing: this reads a receiver whose name holds "ledger"; a client held
 * under another name is not caught.
 */
const SRC = new URL('.', import.meta.url).pathname;
const DOOR = 'ledger-receipt.ts';
const BARE_POST = /\b\w*[lL]edger\w*\??\.post\s*\(/;

function productFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return productFiles(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

function bareLedgerPosts(files: readonly { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) =>
    path === DOOR ? [] : text.split('\n').flatMap((line, i) => (BARE_POST.test(line.replace(/\/\/.*$/, '')) ? [`${path}:${i + 1}`] : [])),
  );
}

describe('one door to post to the ledger', () => {
  it('no svc-pay product file calls ledger.post outside ledger-receipt.ts', () => {
    const files = productFiles(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
    expect(files.length).toBeGreaterThan(50);
    expect(bareLedgerPosts(files)).toEqual([]);
  });

  it('catches a bare post, the way the chargeback posts were written', () => {
    const past = 'const tx = await ledger.post(recipes.chargebackOpen(input));\nconst t = await this.ledger.post(\n';
    expect(bareLedgerPosts([{ path: 'chargeback-ledger.ts', text: past }])).toEqual(['chargeback-ledger.ts:1', 'chargeback-ledger.ts:2']);
    expect(bareLedgerPosts([{ path: DOOR, text: past }])).toEqual([]);
  });
});
