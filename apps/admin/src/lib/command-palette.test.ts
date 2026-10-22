import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { paletteEntries, searchPalette } from './command-palette';
import { resolveScreen } from './founder-ops/screens';
import { MODULE_IDS, MODULE_ROUTES } from './modules';

const pageFile = (href: string) =>
  fileURLToPath(new URL(`../app/(console)${href === '/' ? '' : href.split('#')[0]}/page.tsx`, import.meta.url));

describe('command palette entries', () => {
  const all = paletteEntries([...MODULE_IDS]);

  it('every page and action opens a real page of this console', () => {
    for (const e of all) if (e.href) expect(existsSync(pageFile(e.href)) || resolveScreen(e.href) !== null, e.href).toBe(true);
    const pages = all.filter((e) => e.kind === 'page').map((e) => e.href);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it('lists the founder merchant screens too, so the merchant desk needs no search of its own', () => {
    expect(searchPalette(all, 'ledger integrity')[0]).toMatchObject({ href: '/system/integrity' });
  });

  it('lists every nav page', () => {
    for (const r of MODULE_ROUTES) expect(all.some((e) => e.kind === 'page' && e.href === r.href)).toBe(true);
  });

  it('leaves out pages and actions of a module that is switched off', () => {
    const crmOnly = paletteEntries(['crm']);
    expect(crmOnly.filter((e) => e.href !== null).every((e) => e.href!.startsWith('/crm'))).toBe(true);
    const noLedger = paletteEntries(MODULE_IDS.filter((m) => m !== 'ledger'));
    expect(noLedger.some((e) => e.href === '/ledger' || e.href === '/restore')).toBe(false);
    expect(searchPalette(noLedger, 'ledger').some((e) => e.label === 'Ledger ops')).toBe(false);
  });
});

describe('searching', () => {
  const all = paletteEntries([...MODULE_IDS]);

  it('"ledger" finds the Ledger ops page first, then the ledger actions', () => {
    const hits = searchPalette(all, 'ledger');
    expect(hits[0]).toMatchObject({ kind: 'page', label: 'Ledger ops', href: '/ledger' });
    expect(hits.some((e) => e.kind === 'action' && e.label === 'Freeze or unfreeze ledger posting')).toBe(true);
    expect(hits.some((e) => e.label === 'CRM')).toBe(false);
  });

  it('every word must match, in any order, any case', () => {
    expect(searchPalette(all, 'TRADE orders').map((e) => e.href)).toContain('/trade-ops/orders');
    expect(searchPalette(all, 'orders trade').map((e) => e.href)).toContain('/trade-ops/orders');
    expect(searchPalette(all, 'zzzz')).toEqual([]);
  });

  it('an empty query lists the pages only', () => {
    const hits = searchPalette(all, '  ');
    expect(hits.length).toBeGreaterThan(MODULE_ROUTES.length);
    expect(hits.every((e) => e.kind === 'page')).toBe(true);
  });
});
