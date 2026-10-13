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
  moduleForPage,
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
