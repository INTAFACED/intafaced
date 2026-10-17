import { describe, expect, it } from 'vitest';
import { isModuleEnabled, moduleDisabledResponse, moduleForApi, moduleForPage } from '@/lib/modules';

describe('the merchants module entry', () => {
  it('owns every Merchants page and the Merchants BFF, including encoded spellings', () => {
    for (const path of [
      '/merchants',
      '/merchants/all',
      '/merchants/approvals',
      '/merchants/registries/venues/new',
      '/merchants/22222222-2222-4222-8222-222222222222',
      '/%6Derchants/all',
      '/merchants/../merchants/all',
    ]) {
      expect(moduleForPage(path), path).toBe('merchants');
    }
    for (const path of ['/api/merchants', '/api/merchants/registries', '/api/merchants/controls', '/api/%6Derchants/registries']) {
      expect(moduleForApi(path), path).toBe('merchants');
    }
    expect(moduleForPage('/merchantsfoo')).toBeNull();
    expect(moduleForApi('/api/merchantsfoo')).toBeNull();
  });

  it('is on by default and off when ADMIN_MODULES leaves it out (launch runs with crm only)', () => {
    expect(isModuleEnabled('merchants', {})).toBe(true);
    expect(isModuleEnabled('merchants', { ADMIN_MODULES: 'crm' })).toBe(false);
    expect(isModuleEnabled('merchants', { ADMIN_MODULES: 'crm, merchants' })).toBe(true);
    expect(moduleDisabledResponse('merchants', { ADMIN_MODULES: 'crm' })?.status).toBe(404);
    expect(moduleDisabledResponse('merchants', { ADMIN_MODULES: 'crm' })?.headers.get('cache-control')).toBe('no-store');
  });
});
