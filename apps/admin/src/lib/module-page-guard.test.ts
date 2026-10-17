import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => nav);

import { requireModulePage } from './module-page-guard';
import { MODULE_ROUTES } from './modules';

describe('page-level module guard', () => {
  it('lets an enabled module render, and everything when no gate is set', () => {
    expect(() => requireModulePage('crm', { ADMIN_MODULES: 'crm' })).not.toThrow();
    expect(() => requireModulePage('tools', {})).not.toThrow();
  });

  it('sends a disabled module to the first enabled one, like the middleware does', () => {
    for (const id of ['accounts', 'jurisdiction', 'launch', 'ledger', 'tools', 'killswitches'] as const)
      expect(() => requireModulePage(id, { ADMIN_MODULES: 'crm' }), id).toThrow('REDIRECT:/crm');
  });

  it('404s when no module is enabled', () => {
    expect(() => requireModulePage('crm', { ADMIN_MODULES: 'bogus' })).toThrow('NOT_FOUND');
  });

  it('is called, with the right module id, by every console page', () => {
    for (const route of MODULE_ROUTES) {
      const file = fileURLToPath(new URL(`../app/(console)${route.href === '/' ? '' : route.href}/page.tsx`, import.meta.url));
      expect(readFileSync(file, 'utf8'), route.href).toContain(`requireModulePage('${route.id}')`);
    }
  });

  it('guards every trade desk room through its layout', () => {
    const layout = fileURLToPath(new URL('../app/(console)/trade-ops/layout.tsx', import.meta.url));
    expect(readFileSync(layout, 'utf8')).toContain("requireModulePage('tradeops')");
    expect(() => requireModulePage('tradeops', { ADMIN_MODULES: 'crm' })).toThrow('REDIRECT:/crm');
  });
});
