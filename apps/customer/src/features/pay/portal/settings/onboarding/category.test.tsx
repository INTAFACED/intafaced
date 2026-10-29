import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { failed, noop, plain, ready } from '../account/testing';
import { BusinessCategoryView } from './Category';
import type { CategoryView } from './category-api';

// TEST DATA ONLY: the categories stand in for the table INTAFACED publishes; no live reserve magnitude.
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const shop = { key: 'test-shop', label: 'TEST online shop', class: 'permissionless' as const, reserve: null, extraDocuments: [] };
const gaming = {
  key: 'test-gaming',
  label: 'TEST gaming',
  class: 'restricted' as const,
  reserve: { percent: '5.00', holdDays: 90 },
  extraDocuments: ['TEST gaming licence'],
};
const everyday = { key: 'test-everyday', label: 'TEST everyday shop', class: 'standard' as const, reserve: null, extraDocuments: [] };
const unset = { key: 'test-travel', label: 'TEST travel', class: 'restricted' as const, reserve: null, extraDocuments: [] };
const weapons = { key: 'test-weapons', label: 'TEST weapons', class: 'prohibited' as const, reserve: null, extraDocuments: [] };
const table: CategoryView = {
  merchantId: MERCHANT,
  policy: { tableVersion: 4, categories: [everyday, shop, gaming, unset, weapons] },
  chosen: null,
  locked: false,
};
const choose = async () => ({ ok: true as const, data: table });
const html = (resource: Parameters<typeof BusinessCategoryView>[0]['resource'], canChoose = true) => {
  const out = renderToString(<BusinessCategoryView resource={resource} reload={noop} canChoose={canChoose} choose={choose} />);
  plain(out);
  return out;
};

describe('business category on the Compliance page', () => {
  it('says no rule is set while the table is empty, and offers no choice', () => {
    const out = html(ready({ ...table, policy: { tableVersion: 0, categories: [] } }));
    expect(out).toContain('No rule set');
    expect(out).toContain('no business can choose one or go live');
    expect(out).not.toContain('<select');
  });

  it('shows every category with its class rule, and a high-risk one with its reserve and documents', () => {
    const out = html(ready(table));
    expect(out).toContain('TEST online shop');
    expect(out).toContain('Card, crypto and bank transfer payments. No extra documents.');
    expect(out).toContain('Crypto only');
    expect(out).toContain('Crypto payments only. No extra documents.');
    expect(out).toContain('High risk');
    expect(out).toContain('No card payments (crypto and bank transfer only), extra documents and a reserve.');
    expect(out).toContain('5.00% of payments, held for 90 days');
    expect(out).toContain('TEST gaming licence');
    expect(out).toContain('Not set. A business in this category can’t go live without it.');
    expect(out).toContain('every payment and checkout is refused');
    expect(out).toContain('You haven’t chosen a category yet');
    expect(out).toMatch(/<select>/);
  });

  it('shows the chosen category, and locks it once the business is verified', () => {
    const chosen = { category: gaming, tableVersion: 4, chosenAt: '2026-10-24T06:00:00.000Z' };
    const open = html(ready({ ...table, chosen }));
    expect(open).toContain('Your category');
    expect(open).toMatch(/<select>/);
    const locked = html(ready({ ...table, chosen, locked: true }));
    expect(locked).toContain('Ask INTAFACED support to change it');
    expect(locked).not.toContain('<select');
  });

  it('lets only the owner choose', () => {
    const out = html(ready(table), false);
    expect(out).toContain('Only the account owner can choose the business category.');
    expect(out).not.toContain('<select');
  });

  it('names a failed read rather than an empty table', () => {
    const out = html(failed('pay.category_not_found', 404, 'error'));
    expect(out).not.toContain('No rule set');
  });
});
