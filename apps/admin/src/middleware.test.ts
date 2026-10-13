import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { middleware } from './middleware';

const original = process.env.ADMIN_MODULES;
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_MODULES;
  else process.env.ADMIN_MODULES = original;
});

const run = (path: string) => middleware(new NextRequest(`https://admin.example${path}`));
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('admin middleware module gate', () => {
  it('unset: every page and API passes through', () => {
    delete process.env.ADMIN_MODULES;
    for (const path of ['/', '/crm', '/accounts', '/tools', '/api/kill-switch', '/api/operator-tools', '/api/crm']) {
      expect(passes(run(path))).toBe(true);
    }
  });

  it('ADMIN_MODULES=crm: CRM, login and session still work', () => {
    process.env.ADMIN_MODULES = 'crm';
    for (const path of ['/crm', '/crm/', '/login', '/api/crm', '/api/crm/workflows', '/api/crm/privacy', '/api/session', '/api/session/passkey']) {
      expect(passes(run(path)), path).toBe(true);
    }
  });

  it('ADMIN_MODULES=crm: / redirects to /crm and other pages redirect too', () => {
    process.env.ADMIN_MODULES = 'crm';
    for (const path of ['/', '/accounts', '/launch', '/jurisdiction', '/ledger', '/tools', '/tools/x']) {
      const res = run(path);
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/crm');
    }
  });

  it('ADMIN_MODULES=crm: non-CRM APIs return 404', async () => {
    process.env.ADMIN_MODULES = 'crm';
    for (const path of ['/api/accounts', '/api/kill-switch', '/api/ledger-freeze', '/api/operator-tools', '/api/analytics/warehouse']) {
      const res = run(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('a module listed in the env stays on, an unlisted one is off', () => {
    process.env.ADMIN_MODULES = 'crm,ledger';
    expect(passes(run('/ledger'))).toBe(true);
    expect(passes(run('/api/ledger-freeze'))).toBe(true);
    expect(run('/tools').status).toBe(307);
    expect(run('/api/operator-tools').status).toBe(404);
  });

  it('nothing enabled: pages 404 instead of redirecting in a loop', () => {
    process.env.ADMIN_MODULES = 'bogus';
    expect(run('/crm').status).toBe(404);
    expect(run('/api/crm').status).toBe(404);
    expect(passes(run('/login'))).toBe(true);
  });
});
