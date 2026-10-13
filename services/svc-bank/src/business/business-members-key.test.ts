import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { businessMembers } from '../db/schema.js';

describe('business_members primary key', () => {
  it('is (account_id, user_id), matching the applied SQL pair', () => {
    const { primaryKeys } = getTableConfig(businessMembers);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((column) => column.name)).toEqual(['account_id', 'user_id']);
  });
});
