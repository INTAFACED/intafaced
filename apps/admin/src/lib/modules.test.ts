import { describe, expect, it } from 'vitest';
import {
  MODULE_IDS,
  MODULE_ROUTES,
  configuredModules,
  enabledModuleIds,
  firstEnabledHref,
  isModuleEnabled,
  moduleDisabledResponse,
  moduleForApi,
  isUndecodablePath,
  moduleForPage,
  navNeeded,
} from './modules';

describe('ADMIN_MODULES gate', () => {
  it('unset or blank leaves every module on', () => {
    for (const env of [{}, { ADMIN_MODULES: '' }, { ADMIN_MODULES: '  ' }]) {
      expect(configuredModules(env)).toBeNull();
      expect(enabledModuleIds(env)).toEqual(MODULE_IDS);
      expect(moduleDisabledResponse('tools', env)).toBeNull();
    }
  });

  it('crm only enables crm and hides the rest', () => {
    const env = { ADMIN_MODULES: 'crm' };
    expect(enabledModuleIds(env)).toEqual(['crm']);
    expect(isModuleEnabled('crm', env)).toBe(true);
    for (const id of MODULE_IDS.filter((m) => m !== 'crm')) expect(isModuleEnabled(id, env)).toBe(false);
    expect(firstEnabledHref(env)).toBe('/crm');
  });

  it('tolerates spaces and case, and ignores unknown ids (fails closed)', () => {
    expect(enabledModuleIds({ ADMIN_MODULES: ' CRM , ledger ,nope' })).toEqual(['crm', 'ledger']);
    expect(enabledModuleIds({ ADMIN_MODULES: 'crmm' })).toEqual([]);
    expect(firstEnabledHref({ ADMIN_MODULES: 'crmm' })).toBeNull();
  });

  it('maps every nav page to its module, with / as kill-switches', () => {
    expect(MODULE_ROUTES.map((r) => r.id)).toEqual(MODULE_IDS);
    for (const route of MODULE_ROUTES) {
      expect(moduleForPage(route.href)).toBe(route.id);
      if (route.href !== '/') expect(moduleForPage(`${route.href}/`)).toBe(route.id);
    }
    expect(moduleForPage('/login')).toBeNull();
    expect(moduleForPage('/accountsx')).toBeNull();
  });

  it('matches the decoded path, so percent-encoding cannot hide a module', () => {
    expect(moduleForPage('/%74ools')).toBe('tools');
    expect(moduleForPage('/%6Cedger/')).toBe('ledger');
    expect(moduleForPage('/%61ccounts')).toBe('accounts');
    expect(moduleForPage('/%2574ools')).toBe('tools'); // double-encoded
    expect(moduleForPage('//tools')).toBe('tools');
    expect(moduleForPage('/crm/../tools')).toBe('tools');
    expect(moduleForPage('/%63rm')).toBe('crm');
    expect(moduleForApi('/api/%61ccounts')).toBe('accounts');
    expect(moduleForApi('/api/operator%2Dtools/x')).toBe('tools');
    expect(moduleForPage('/login')).toBeNull();
  });

  it('flags a malformed or endlessly nested encoding so the gate can refuse it', () => {
    for (const path of ['/%', '/tools%', '/%E0%A4%A', '/crm/%zz']) expect(isUndecodablePath(path), path).toBe(true);
    expect(isUndecodablePath('/%25252525252574ools')).toBe(true); // still changing after 5 rounds
    for (const path of ['/', '/crm', '/%74ools', '/%2574ools', '/login']) expect(isUndecodablePath(path), path).toBe(false);
  });

  it('maps API routes; session APIs belong to no module', () => {
    expect(moduleForApi('/api/crm')).toBe('crm');
    expect(moduleForApi('/api/crm/workflows')).toBe('crm');
    expect(moduleForApi('/api/crm/privacy')).toBe('crm');
    expect(moduleForApi('/api/accounts')).toBe('accounts');
    expect(moduleForApi('/api/kill-switch')).toBe('killswitches');
    expect(moduleForApi('/api/ledger-freeze')).toBe('ledger');
    expect(moduleForApi('/api/operator-tools')).toBe('tools');
    expect(moduleForApi('/api/analytics/warehouse')).toBe('tools');
    expect(moduleForApi('/api/session')).toBeNull();
    expect(moduleForApi('/api/session/passkey')).toBeNull();
  });

  it('route guard answers 404 only for disabled modules', async () => {
    const env = { ADMIN_MODULES: 'crm' };
    expect(moduleDisabledResponse('crm', env)).toBeNull();
    const res = moduleDisabledResponse('tools', env);
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: 'not_found' });
  });
});

describe('navigation bar', () => {
  it('is hidden when only one module is enabled, and shown from two', () => {
    expect(navNeeded(1)).toBe(false);
    expect(navNeeded(0)).toBe(false);
    expect(navNeeded(2)).toBe(true);
    expect(navNeeded(MODULE_ROUTES.length)).toBe(true);
  });
});

describe('Security is always on', () => {
  it('belongs to no module, so no ADMIN_MODULES setting can gate its page or API', async () => {
    const { ALWAYS_ON_ROUTES } = await import('./modules');
    expect(ALWAYS_ON_ROUTES).toEqual([{ href: '/security', label: 'Security' }]);
    for (const env of [{}, { ADMIN_MODULES: 'crm' }, { ADMIN_MODULES: 'crmm' }]) {
      expect(moduleForPage('/security')).toBeNull();
      expect(moduleForPage('/%73ecurity')).toBeNull();
      expect(moduleForApi('/api/security')).toBeNull();
      expect(moduleForApi('/api/security/passkeys/abc')).toBeNull();
      expect(moduleForApi('/api/reset')).toBeNull();
      expect(moduleForPage('/reset')).toBeNull();
      expect(enabledModuleIds(env).includes('security' as never)).toBe(false);
    }
  });
});
