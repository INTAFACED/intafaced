import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readData } from '@/lib/ops-desk/model';
import { codeWords } from '@/lib/desk/words';
import { moduleForPage } from '@/lib/modules';
import { CUSTOMER_TABS, INDICATOR_STRIP, RISK_CARD, customerId, customerTab, tabPlan } from './record';

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
    const docs = tabPlan('documents', USER);
    expect(docs.reads.map((r) => [r.module, r.procedure, r.input])).toEqual([
      ['identity', 'kyc.listDocuments', { userId: USER, limit: 50 }],
      ['identity', 'kyc.selfie.listFor', { userId: USER, limit: 50 }],
    ]);
    expect(docs.unwired.map((u) => u.id)).toEqual(['documents.decisions']);
    expect(docs.reads[0]!.rowAction).toBe('identity.kyc_document.open');
    expect(docs.reads[0]!.refusals?.['kyc_doc.unwired']).toContain('IDENTITY_KYC_DOC_KEY');
    expect(docs.reads[1]!.rowAction).toBe('identity.kyc_selfie.decide');
    expect(docs.reads[1]!.rowsKey).toBe('selfies');
  });
  it('names procedures the owning services serve today', () => {
    expect(service('svc-bank/src/router/ops.router.ts')).toContain('customerBalances:');
    // The cards blocker: svc-bank's card list is the owner's own, read by the signed-in principal.
    expect(service('svc-bank/src/router/cards.router.ts')).toContain('bank.cards.cardsOf(ctx.principal.userId');
    // The tickets blocker: svc-support's account read goes by ticket, strictly.
    expect(service('svc-support/src/router.ts')).toContain('.input(z.object({ ticketId: z.string().guid() }).strict())');
    expect(service('svc-trade/src/controls/router.ts')).toMatch(/history: protectedProcedure/);
    // Documents: identity's meta-only list for one subject, compliance scope, limit required, no bytes.
    expect(service('svc-identity/src/router.ts')).toMatch(
      /listDocuments: scopedProcedure\('admin:compliance'\)\s+\.input\(z\.object\(\{ userId: z\.string\(\)\.guid\(\), limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\) \}\)\)/,
    );
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

describe('risk card', () => {
  it('states that there is no risk level and why, with no score, band or colour', () => {
    expect(RISK_CARD.title).toBe('No risk level');
    expect(RISK_CARD.reason).toContain('No risk ruleset exists');
    expect(`${RISK_CARD.title} ${RISK_CARD.reason}`).not.toMatch(/\b(low|medium|high|score of|\d+\s*\/\s*\d+)\b/i);
  });
});

describe('indicator strip', () => {
  it('says not set, why, and the code, with no value', () => {
    expect(INDICATOR_STRIP.title).toBe('Not set');
    expect(INDICATOR_STRIP.code).toBe('compliance.indicators_unset');
    expect(INDICATOR_STRIP.reason).toContain('No account indicators are configured');
    expect(`${INDICATOR_STRIP.title} ${INDICATOR_STRIP.reason}`).not.toMatch(/\d/);
  });
});

describe('documents tab', () => {
  const row = {
    id: '3c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5',
    userId: USER,
    contentType: 'image/png',
    byteLength: 2048,
    storedBy: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    reviewStatus: 'pending',
    reviewRecordId: '4d2e3f4a-5b6c-4d7e-8f80-91a2b3c4d5e6',
    reviewTier: 'full',
  };
  it('reads each of identity’s document rows with the status of the verification it is attached to', () => {
    const [docs] = tabPlan('documents', USER).reads;
    const read = readData(docs!, [
      row,
      { ...row, id: '5e3f4a5b-6c7d-4e8f-9081-a2b3c4d5e6f7', reviewStatus: 'not_attached', reviewRecordId: null, reviewTier: null },
    ]);
    expect(read).toMatchObject({ shape: 'list', rows: [{ id: row.id }, { id: '5e3f4a5b-6c7d-4e8f-9081-a2b3c4d5e6f7' }] });
    const status = (i: number) => (read?.shape === 'list' ? read.rows[i]!.cells.find((c) => c.key === 'reviewStatus')?.value : undefined);
    expect([status(0), status(1)]).toEqual(['pending', 'not_attached']);
    expect(codeWords('not_attached')).toBe('Not attached to a verification');
  });
  it('refuses a row without its status, so a document never reads as not attached by omission', () => {
    const [docs] = tabPlan('documents', USER).reads;
    const { reviewStatus: _drop, ...noStatus } = row;
    expect(readData(docs!, [noStatus])).toBeNull();
  });
  it('names the missing per-document decisions as the one parked part', () => {
    const parked = tabPlan('documents', USER).unwired.map((u) => u.id);
    expect(parked).toEqual(['documents.decisions']);
    expect(tabPlan('documents', USER).unwired[0]!.reason).toContain('verification it is attached to');
  });
});
