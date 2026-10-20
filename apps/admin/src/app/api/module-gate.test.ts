import { afterEach, describe, expect, it } from 'vitest';
import * as accounts from './accounts/route';
import * as warehouse from './analytics/warehouse/route';
import * as crm from './crm/route';
import * as privacy from './crm/privacy/route';
import * as workflows from './crm/workflows/route';
import * as killSwitch from './kill-switch/route';
import * as ledgerFreeze from './ledger-freeze/route';
import * as operatorTools from './operator-tools/route';
import * as bankOps from './bank-ops/route';
import * as payOps from './pay-ops/route';
import * as payOpsTransfer from './pay-ops/transfer/route';
import * as payOpsPage from './pay-ops/page/route';
import * as p2pOps from './p2p-ops/route';
import * as academyOps from './academy-ops/route';
import * as moreOps from './more-ops/route';
import * as protocolOps from './protocol-ops/route';
import * as identityKeys from './identity-ops/keys/route';

const original = process.env.ADMIN_MODULES;
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_MODULES;
  else process.env.ADMIN_MODULES = original;
});

const get = (path: string) => new Request(`https://admin.example${path}`);
const post = (path: string) =>
  new Request(`https://admin.example${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });

const nonCrm = [
  ['accounts', accounts, '/api/accounts'],
  ['kill-switch', killSwitch, '/api/kill-switch'],
  ['ledger-freeze', ledgerFreeze, '/api/ledger-freeze'],
  ['identity-ops keys', identityKeys, '/api/identity-ops/keys'],
  ['operator-tools', operatorTools, '/api/operator-tools'],
  ['analytics/warehouse', warehouse, '/api/analytics/warehouse'],
] as const;

const readOnly = [
  ['bank-ops', bankOps, '/api/bank-ops'],
  ['pay-ops', payOps, '/api/pay-ops'],
  ['pay-ops transfer', payOpsTransfer, '/api/pay-ops/transfer?id=abcdefgh'],
  ['pay-ops page', payOpsPage, '/api/pay-ops/page?read=pay.failed-standing&cursor=abc'],
  ['p2p-ops', p2pOps, '/api/p2p-ops'],
  ['academy-ops', academyOps, '/api/academy-ops'],
  ['more-ops', moreOps, '/api/more-ops'],
  ['protocol-ops', protocolOps, '/api/protocol-ops'],
] as const;

describe('route-level module gate', () => {
  it('ADMIN_MODULES=crm: non-CRM API handlers answer 404 before doing anything', async () => {
    process.env.ADMIN_MODULES = 'crm';
    for (const [name, route, path] of nonCrm) {
      for (const res of [await route.GET(get(path)), await route.POST(post(path))]) {
        expect(res.status, name).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
    }
  });

  it('ADMIN_MODULES=crm: the module ops desks answer 404 too', async () => {
    process.env.ADMIN_MODULES = 'crm';
    for (const [name, route, path] of readOnly) expect((await route.GET(get(path))).status, name).toBe(404);
  });

  it('ADMIN_MODULES=crm: CRM handlers are not 404 (they reach their own auth)', async () => {
    process.env.ADMIN_MODULES = 'crm';
    for (const [route, path] of [
      [crm, '/api/crm'],
      [workflows, '/api/crm/workflows'],
      [privacy, '/api/crm/privacy'],
    ] as const) {
      expect((await route.GET(get(path))).status).not.toBe(404);
    }
  });

  it('ADMIN_MODULES=accounts: CRM handlers answer 404', async () => {
    process.env.ADMIN_MODULES = 'accounts';
    for (const [route, path] of [
      [crm, '/api/crm'],
      [workflows, '/api/crm/workflows'],
      [privacy, '/api/crm/privacy'],
    ] as const) {
      expect((await route.GET(get(path))).status).toBe(404);
    }
  });

  it('unset: handlers are not gated (existing auth tests cover their behaviour)', async () => {
    delete process.env.ADMIN_MODULES;
    for (const [, route, path] of nonCrm) expect((await route.GET(get(path))).status).not.toBe(404);
  });
});
