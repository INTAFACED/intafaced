import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => nav);

// Every id a page asks the guard for, in order; the guard itself is the real one.
const guarded = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('./module-page-guard', async (actual) => {
  const real = await actual<typeof import('./module-page-guard')>();
  return {
    requireModulePage: (...args: Parameters<typeof real.requireModulePage>) => {
      guarded.ids.push(args[0]);
      return real.requireModulePage(...args);
    },
  };
});
// A page that reached the founder check (or any read after it) ran past the guard.
const founder = vi.hoisted(() => ({
  requireFounderPage: vi.fn(async () => {
    throw new Error('FOUNDER_CHECK_REACHED');
  }),
}));
vi.mock('@/lib/founder-page', () => founder);

import { requireModulePage } from './module-page-guard';
import { MODULE_ROUTES, type ModuleId } from './modules';

type Page = (props: { searchParams: Promise<Record<string, string>>; params: Promise<Record<string, string>> }) => unknown;
const PAGES: Record<ModuleId, () => Promise<{ default: Page }>> = {
  crm: () => import('@/app/(console)/crm/page'),
  accounts: () => import('@/app/(console)/accounts/page'),
  killswitches: () => import('@/app/(console)/page'),
  launch: () => import('@/app/(console)/launch/page'),
  jurisdiction: () => import('@/app/(console)/jurisdiction/page'),
  ledger: () => import('@/app/(console)/ledger/page'),
  tools: () => import('@/app/(console)/tools/page'),
  merchants: () => import('@/app/(console)/merchants/page'),
  support: () => import('@/app/(console)/support/page'),
  notify: () => import('@/app/(console)/notify/page'),
  'bank-ops': () => import('@/app/(console)/bank-ops/page'),
  'pay-ops': () => import('@/app/(console)/pay-ops/page'),
  'p2p-ops': () => import('@/app/(console)/p2p-ops/page'),
  'academy-ops': () => import('@/app/(console)/academy-ops/page'),
  'more-ops': () => import('@/app/(console)/more-ops/page'),
  'protocol-ops': () => import('@/app/(console)/protocol-ops/page'),
  tradeops: () => import('@/app/(console)/trade-ops/page'),
  'identity-ops': () => import('@/app/(console)/identity-ops/page'),
  'custody-ops': () => import('@/app/(console)/custody-ops/page'),
} as never;
const props = { searchParams: Promise.resolve({}), params: Promise.resolve({}) };
const render = async (page: Page) => page(props);

afterEach(() => {
  vi.unstubAllEnvs();
  guarded.ids.length = 0;
  founder.requireFounderPage.mockClear();
});

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

  it.each(MODULE_ROUTES.map((route) => [route.href, route] as const))(
    'the console page at %s asks for its own module first, and does not render while it is off',
    async (_href, route) => {
      expect(Object.keys(PAGES).sort()).toEqual(MODULE_ROUTES.map((r) => r.id).sort());
      const other = MODULE_ROUTES.find((r) => r.id !== route.id)!;
      const { default: page } = await PAGES[route.id]();
      vi.stubEnv('ADMIN_MODULES', other.id);
      await expect(render(page)).rejects.toThrow(`REDIRECT:${other.href}`);
      expect(guarded.ids).toEqual([route.id]);
      expect(founder.requireFounderPage).not.toHaveBeenCalled();
    },
  );

  it('guards every trade desk room through its layout', async () => {
    const { default: TradeOpsLayout } = await import('@/app/(console)/trade-ops/layout');
    vi.stubEnv('ADMIN_MODULES', 'crm');
    expect(() => TradeOpsLayout({ children: null })).toThrow('REDIRECT:/crm');
    expect(guarded.ids).toEqual(['tradeops']);
    vi.stubEnv('ADMIN_MODULES', 'tradeops');
    expect(TradeOpsLayout({ children: 'room' })).toMatchObject({ props: { children: 'room' } });
    expect(() => requireModulePage('tradeops', { ADMIN_MODULES: 'crm' })).toThrow('REDIRECT:/crm');
  });
});
