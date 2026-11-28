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
    call(
      this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },
      record: { kind: string; module: string; path: string; output: unknown },
      input?: unknown,
      opts?: unknown,
    ) {
      // tooling/codemod/call-records: a call by its record reaches this double's own query or mutate, as the client sends it.
      return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [
        record.module,
        record.path,
        input,
        record.output,
        opts,
      ]);
    },
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
