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
    expect(tabPlan('tickets', USER).reads).toEqual([]);
    expect(tabPlan('tickets', USER).unwired[0]!.reason).toContain('refuses on purpose to answer about an arbitrary account');
    const docs = tabPlan('documents', USER);
    expect(docs.reads.map((r) => [r.module, r.procedure, r.input])).toEqual([
      ['identity', 'kyc.listDocuments', { userId: USER, limit: 50 }],
      ['identity', 'kyc.historyFor', { userId: USER, limit: 200 }],
      ['identity', 'kyc.selfie.listFor', { userId: USER, limit: 50 }],
    ]);
    expect(docs.unwired.map((u) => u.id)).toEqual(['documents.decisions']);
    expect(docs.reads[0]!.rowAction).toBe('identity.kyc_document.open');
    expect(docs.reads[0]!.refusals?.['kyc_doc.unwired']).toContain('IDENTITY_KYC_DOC_KEY');
    expect(docs.reads[1]!.rowsKey).toBe('cases');
    expect(docs.reads[2]!.rowAction).toBe('identity.kyc_selfie.decide');
    expect(docs.reads[2]!.rowsKey).toBe('selfies');
    const words = Object.fromEntries(docs.reads[2]!.columns.map((c) => [c.key, c.words]));
    expect(words.status).toEqual({ provided: 'Waiting for a person to compare it', accepted: 'Accepted', rejected: 'Rejected' });
    expect(Object.keys(words.via ?? {})).toEqual(['this_device', 'handoff']);
    expect(words.captureCheck?.not_checked).toContain('no automatic liveness or face-match check');
  });
  it('names procedures the owning services serve today', () => {
    expect(service('svc-bank/src/router/ops.router.ts')).toContain('customerBalances:');
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

describe('cards tab', () => {
  const card = {
    id: '3c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5',
    assetId: 'USDT',
    settlementAssetId: 'USDT',
    issuer: 'sim',
    simulated: true,
    panTail: '4242',
    status: 'closed',
    cardType: 'virtual',
    cashbackBps: 0,
    perAuthorizationLimit: '50',
    dailyLimit: null,
    monthlyLimit: null,
    cashLimit: null,
    online: true,
    contactless: true,
    atm: true,
    abroad: true,
    usesAllowed: null,
    designId: null,
    deliverySpeed: null,
    replacesCardId: null,
    replacedByCardId: null,
  };
  it('reads svc-bank ops.customerCards for this account, at svc-bank’s page cap, as the cards.list read', () => {
    const plan = tabPlan('cards', USER);
    expect(plan.reads.map((r) => [r.id, r.module, r.procedure, r.input, r.shape, r.rowsKey, r.idKey, r.page])).toEqual([
      ['cards.list', 'bank', 'ops.customerCards', { userId: USER, limit: 200 }, 'list', 'cards', 'id', 200],
    ]);
    const shown = plan.reads[0]!.columns.filter((c) => !c.detail).map((c) => c.key);
    expect(shown).toEqual(expect.arrayContaining(['id', 'status']));
    expect(plan.reads[0]!.columns.map((c) => c.key)).not.toContain('shippingAddress');
    expect(plan.reads[0]!.note).toContain('When 200 are shown, older cards may exist');
    expect(plan.reads[0]!.forbiddenText).toContain('admin:read');
    expect(plan.reads[0]!.refusals?.['bank.ops_audit_unavailable']).toContain('read nothing');
    expect(plan.unwired.map((u) => u.id)).toEqual(['cards.payments']);
    expect(plan.unwired.map((u) => u.id)).not.toContain('cards.list');
  });
  it('shows each card with its id and status in the table, a closed card as closed, and no card as an honest empty', () => {
    const [read] = tabPlan('cards', USER).reads;
    const data = readData(read!, {
      userId: USER,
      cards: [card, { ...card, id: '5e3f4a5b-6c7d-4e8f-9081-a2b3c4d5e6f7', status: 'active' }],
    });
    expect(data).toMatchObject({ shape: 'list', rows: [{ id: card.id }, { id: '5e3f4a5b-6c7d-4e8f-9081-a2b3c4d5e6f7' }] });
    const cells = data?.shape === 'list' ? data.rows[0]!.cells.filter((c) => !c.detail) : [];
    expect(cells.find((c) => c.key === 'id')?.value).toBe(card.id);
    expect(cells.find((c) => c.key === 'status')).toMatchObject({ value: 'closed', words: 'Closed' });
    expect(readData(read!, { userId: USER, cards: [] })).toMatchObject({ shape: 'list', rows: [] });
    expect(read!.emptyText).toContain('no card');
  });
  it('refuses a status it has no words for, and a row without its status, rather than guess', () => {
    const [read] = tabPlan('cards', USER).reads;
    expect(readData(read!, { userId: USER, cards: [{ ...card, status: 'lost' }] })).toBeNull();
    const { status: _drop, ...noStatus } = card;
    expect(readData(read!, { userId: USER, cards: [noStatus] })).toBeNull();
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

describe('a tab whose staff area the person may not read is denied (J-ops-console-02 #3)', () => {
  it('a founder reads every tab; TEST support staff are denied the cards tab only', async () => {
    const { CUSTOMER_TABS, mayReadTab } = await import('./tabs');
    for (const tab of CUSTOMER_TABS) expect(mayReadTab({ kind: 'founder' }, tab)).toBe(true);
    const support = { kind: 'staff', readAreas: ['accounts', 'payments', 'trading', 'documents'] } as const;
    expect(CUSTOMER_TABS.filter((tab) => !mayReadTab(support, tab))).toEqual(['cards']);
    expect(CUSTOMER_TABS.filter((tab) => mayReadTab({ kind: 'staff', readAreas: [] }, tab))).toEqual([]);
  });
});

describe('the KYC case detail reads its own case and only its verification’s documents (J-ops-console-02 #5)', () => {
  it('filters the same reads by case id and by verification id, with the same document action', async () => {
    const { identityDocumentsRead, kycCasesRead } = await import('./record');
    const one = kycCasesRead(USER, 'c-1');
    expect(one).toMatchObject({ id: 'identity.kyc-case', procedure: 'kyc.historyFor', rowsWhere: { key: 'id', equals: 'c-1' } });
    expect(kycCasesRead(USER).rowsWhere).toBeUndefined();
    const docs = identityDocumentsRead(USER, 'r-1');
    expect(docs).toMatchObject({
      id: 'identity.documents',
      procedure: 'kyc.listDocuments',
      rowAction: 'identity.kyc_document.open',
      rowsWhere: { key: 'reviewRecordId', equals: 'r-1' },
    });
    expect(identityDocumentsRead(USER).rowsWhere).toBeUndefined();
  });
});
