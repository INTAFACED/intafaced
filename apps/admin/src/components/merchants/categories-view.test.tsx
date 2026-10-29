import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import type { CategoryPolicyEvent, CategoryPolicyView } from '@intafaced/contracts/business-category';
import { CategoriesView } from './categories-view';

// TEST DATA ONLY: the founders, categories and reserve stand in for the table INTAFACED publishes.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-24T06:00:00.000Z';
const gaming = {
  key: 'test-gaming',
  label: 'TEST gaming',
  class: 'restricted' as const,
  reserve: { percent: '5.00', holdDays: 90 },
  extraDocuments: ['TEST gaming licence'],
  version: 2,
  updatedAt: at,
  updatedBy: A,
  approvedBy: B,
};
const travel = { ...gaming, key: 'test-travel', label: 'TEST travel', reserve: null, extraDocuments: [], version: 1 };
const shop = { ...travel, key: 'test-shop', label: 'TEST shop', class: 'standard' as const };
const policy: CategoryPolicyView = { tableVersion: 3, categories: [gaming, travel, shop] };
const event: CategoryPolicyEvent = {
  seq: 3,
  key: 'test-gaming',
  actorId: A,
  approverId: B,
  before: { key: 'test-gaming', label: 'TEST gaming', class: 'restricted', reserve: null, extraDocuments: [] },
  after: { key: 'test-gaming', label: 'TEST gaming', class: 'restricted', reserve: gaming.reserve, extraDocuments: gaming.extraDocuments },
  reason: 'TEST set the reserve',
  createdAt: at,
};
const ok = <T,>(data: T) => ({ kind: 'ok' as const, data });

describe('the business category console', () => {
  it('says "No rule set" for an empty table, as a successful read, and still offers the editor', () => {
    const out = renderToStaticMarkup(<CategoriesView policy={ok({ tableVersion: 0, categories: [] })} history={ok([])} />);
    expect(out).toContain('No rule set');
    expect(out).toContain('none can go live');
    expect(out).toContain('Add a category');
    expect(out).not.toContain('data-testid="category-table"');
  });

  it('shows each category with its class rule, reserve or "Not set", documents, version and both founders', () => {
    const out = renderToStaticMarkup(<CategoriesView policy={ok(policy)} history={ok([event])} />);
    expect(out).toContain('Table version 3');
    expect(out).toContain('No card rails');
    expect(out).toContain('Every rail: cards, crypto-native and bank transfer.');
    expect(out).toContain('5.00% for 90 days');
    expect(out).toContain('Not set');
    expect(out).toContain('TEST gaming licence');
    expect(out).toContain(A.slice(0, 8));
    expect(out).toContain(B.slice(0, 8));
    expect(out).toContain('#3 Changed');
    expect(out).toContain('TEST set the reserve');
  });

  it('names a failed read instead of showing an empty table', () => {
    const failure = { kind: 'unavailable' as const, requestId: null };
    const out = renderToStaticMarkup(<CategoriesView policy={failure} history={ok([])} />);
    expect(out).not.toContain('No rule set');
    expect(out).not.toContain('Add a category');
  });
});
