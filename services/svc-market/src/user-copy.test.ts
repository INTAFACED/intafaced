import { describe, expect, it } from 'vitest';
import { userCopy } from './user-copy.js';

/**
 * Unit card — user-visible market copy resolves @intafaced/i18n keys
 * 1. Promise: TRK-infra.i18n slice — listing/vendor/commerce refuse strings
 * 2. Break: unknown key invents English instead of echoing the dotted name
 * 3. Done bar: known key renders catalog copy; unknown key === key string
 * 4. Class N
 * 5. Paths: services/svc-market only (do not edit packages/i18n)
 * 6. RED: unknown key becomes a sentence
 * 7. Collision: none vs svc-pay / svc-ws / packages/i18n
 */
describe('userCopy — catalog keys, never invented English', () => {
  it('resolves a known catalog key from @intafaced/i18n', () => {
    expect(userCopy('error.notFound')).toBe('We could not find that.');
    expect(userCopy('market.listing_not_found')).toBe('We could not find that.');
    expect(userCopy('market.insufficient_funds')).toBe('Insufficient balance.');
  });

  it('renders the dotted key when the key is not in the catalog', () => {
    const missing = 'market.commerce.this.key.does.not.exist';
    const rendered = userCopy(missing);

    expect(rendered).toBe(missing);
    expect(rendered).not.toMatch(/ /);
    expect(rendered).not.toMatch(/house commission|basis points|bps|please try|something went wrong/i);
  });

  it('does not invent house-commission copy for a blank-rate refuse code', () => {
    const rendered = userCopy('market.commission_not_configured');
    expect(rendered).toBe('market.commission_not_configured');
    expect(rendered).not.toMatch(/\d/);
    expect(rendered).not.toMatch(/free|0 bps|zero commission/i);
  });

  it('does not invent a 20/50 page for unset list-limit refuse codes', () => {
    expect(userCopy('market.listed_vendors_list_limit_unset')).toBe('market.listed_vendors_list_limit_unset');
    expect(userCopy('market.public_listings_list_limit_unset')).toBe('market.public_listings_list_limit_unset');
    expect(userCopy('market.my_listings_list_limit_unset')).toBe('market.my_listings_list_limit_unset');
    expect(userCopy('market.my_purchases_list_limit_unset')).toBe('market.my_purchases_list_limit_unset');
    expect(userCopy('market.applications_list_limit_unset')).toBe('market.applications_list_limit_unset');
    expect(userCopy('market.history_limit_unset')).toBe('market.history_limit_unset');
    expect(userCopy('market.ops_sales_list_limit_unset')).toBe('market.ops_sales_list_limit_unset');
    expect(userCopy('market.reviews_list_limit_unset')).toBe('market.reviews_list_limit_unset');
    expect(userCopy('market.listed_vendors_list_limit_unset')).not.toMatch(/20|default/i);
    expect(userCopy('market.public_listings_list_limit_unset')).not.toMatch(/50|default/i);
    expect(userCopy('market.my_listings_list_limit_unset')).not.toMatch(/50|default/i);
    expect(userCopy('market.my_purchases_list_limit_unset')).not.toMatch(/50|default/i);
    expect(userCopy('market.applications_list_limit_unset')).not.toMatch(/50|default/i);
    expect(userCopy('market.history_limit_unset')).not.toMatch(/50|default/i);
    expect(userCopy('market.ops_sales_list_limit_unset')).not.toMatch(/50|default/i);
    expect(userCopy('market.reviews_list_limit_unset')).not.toMatch(/50|default/i);
  });
});
