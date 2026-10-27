import { describe, expect, it } from 'vitest';
import { propertyRows } from './SupportRequest';

const t = ((key: string) => key) as Parameters<typeof propertyRows>[1];

describe('the desk priority and type on a customer request (SP-tickets-04)', () => {
  it('shows only what the owner chose, with None set for what the desk has not set', () => {
    expect(propertyRows({ status: 'ok', priority: { value: 'high' }, ticketType: { value: null } }, t)).toEqual([
      ['priorityRow', 'priority_high'],
      ['typeRow', 'propertyNone'],
    ]);
    expect(propertyRows({ status: 'ok', priority: null, ticketType: { value: 'problem' } }, t)).toEqual([['typeRow', 'type_problem']]);
  });

  it('adds no row while loading, and one row naming why when not chosen by the owner or unread', () => {
    expect(propertyRows(null, t)).toEqual([]);
    expect(propertyRows({ status: 'unset', code: 'support.customer_properties_unset' }, t)).toEqual([['propertiesRow', 'propertiesUnset']]);
    expect(propertyRows(null, t, true)).toEqual([['propertiesRow', 'propertiesUnread']]);
  });
});
