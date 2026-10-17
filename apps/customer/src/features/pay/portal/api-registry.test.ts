import { describe, expect, it } from 'vitest';
import { coreApi } from './api-core';
import { moneyApi } from './money/api';
import { paymentsApi } from './payments/api';
import { settingsApi } from './settings/api';
import type { PortalTools } from './api-tools';

describe('portal api parts', () => {
  const tools = {
    userId: 'TEST-user',
    query: async () => ({}),
    mutate: async () => ({}),
    list: async () => ({}),
  } as unknown as PortalTools;
  const parts = { core: coreApi, money: moneyApi, payments: paymentsApi, settings: settingsApi };
  it('never defines the same method in two parts', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const [name, part] of Object.entries(parts))
      for (const method of Object.keys(part(tools))) {
        const earlier = owner.get(method);
        if (earlier) clashes.push(`${method} (${earlier} and ${name})`);
        owner.set(method, name);
      }
    expect(clashes).toEqual([]);
  });
});
