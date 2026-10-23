import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readData } from '@/lib/ops-desk/model';
import { moduleForPage } from '@/lib/modules';
import { CUSTOMER_TABS, customerId, customerTab, tabPlan } from './record';

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const service = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../../services/${path}`, import.meta.url)), 'utf8');

describe('customer record address', () => {
  it('takes an account id from the path, lower-cased, and nothing else', () => {
    expect(customerId(USER.toUpperCase())).toBe(USER);
    expect(customerId(encodeURIComponent(`%${USER}`))).toBeNull();
    expect(customerId('not-an-id')).toBeNull();
    expect(customerId('%E0%A4%A')).toBeNull();
    expect(customerId(`${USER}x`)).toBeNull();
  });
  it('opens money by default, and refuses a tab that does not exist', () => {
    expect(customerTab(undefined)).toBe('money');
    expect(customerTab('cards')).toBe('cards');
    expect(customerTab('wallet')).toBeNull();
    expect(customerTab(['money', 'trade'])).toBeNull();
  });
  it('sits under Account controls, so a console with that module off does not show it', () => {
    expect(moduleForPage(`/accounts/${USER}`)).toBe('accounts');
  });
});

describe('what each tab reads', () => {
  it('reads only for the account in the path, and says what it cannot read on every tab without a read', () => {
    for (const tab of CUSTOMER_TABS) {
      const plan = tabPlan(tab, USER);
      expect(plan.reads.length + plan.unwired.length).toBeGreaterThan(0);
      for (const read of plan.reads) expect(JSON.stringify(read.input)).toContain(USER);
      for (const u of plan.unwired) expect(u.reason.length).toBeGreaterThan(40);
    }
    expect(tabPlan('cards', USER).reads).toEqual([]);
    expect(tabPlan('tickets', USER).reads).toEqual([]);
    expect(tabPlan('cards', USER).unwired[0]!.reason).toContain('no operator read of one customer’s cards');
    expect(tabPlan('tickets', USER).unwired[0]!.reason).toContain('refuses on purpose to answer about an arbitrary account');
  });
  it('names procedures the owning services serve today', () => {
    const bank = service('svc-bank/src/router.ts');
    expect(bank).toContain('customerBalances:');
    // The cards blocker: svc-bank's card list is the owner's own, read by the signed-in principal.
    expect(bank).toContain('bank.cards.cardsOf(ctx.principal.userId');
    // The tickets blocker: svc-support's account read goes by ticket, strictly.
    expect(service('svc-support/src/router.ts')).toContain('.input(z.object({ ticketId: z.string().uuid() }).strict())');
    expect(service('svc-trade/src/controls/router.ts')).toMatch(/history: protectedProcedure/);
    const allowlist = service('svc-pay/src/withdrawals/allowlist/router.ts');
    expect(allowlist).toMatch(/\bmode: founder/);
    expect(allowlist).toMatch(/\bpolicy: founder/);
    expect(service('svc-pay/src/namespaces/founder-admin.ts')).toContain('allowlist: createAllowlistFounderRouter');
    expect(tabPlan('pay', USER).reads.map((r) => r.procedure)).toEqual(['founderAdmin.allowlist.mode', 'founderAdmin.allowlist.policy']);
  });
  it('reads a trading history row and the allowlist settings as the services send them', () => {
    const [history] = tabPlan('trade', USER).reads;
    const row = {
      auditId: USER,
      requestId: USER,
      target: { area: 'trading', userId: USER },
      action: 'restrict',
      reason: 'TEST',
      occurredAt: '2026-10-22T23:00:00.000Z',
      actorUserId: USER,
      before: { target: { area: 'trading', userId: USER }, version: '0', restricted: false },
      after: { target: { area: 'trading', userId: USER }, version: '1', restricted: true },
      outcome: 'changed',
      changed: true,
    };
    expect(readData(history!, [row])).toMatchObject({ shape: 'list', rows: [{ id: USER }] });
    expect(readData(history!, [])).toMatchObject({ shape: 'list', rows: [] });
    const [mode, policy] = tabPlan('pay', USER).reads;
    expect(readData(mode!, { userId: USER, enabled: false, setAt: null })).toMatchObject({ shape: 'record' });
    expect(readData(policy!, { userId: USER, enabled: false, assetId: null, maxAmount: null, setAt: null })).toMatchObject({
      shape: 'record',
    });
    expect(readData(mode!, null)).toBeNull();
  });
});
