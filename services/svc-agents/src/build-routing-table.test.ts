import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client';
import { AgentError } from './errors.js';
import { DEFAULT_ROUTING_TABLE, parseRoutingTable, requireMeterPrice } from './gateway/routing.js';
import { usageCost } from './metering/pricing.js';
import { buildRoutingTable } from './build-routing-table.js';

/**
 * The rates the shipped table used to bill when AGENTS_ROUTING_TABLE was unset.
 * They are not a configured price.
 */
const PLACEHOLDER_TABLE = parseRoutingTable({
  routes: [
    {
      task: 'navigator.plan',
      providerId: 'primary',
      model: 'reasoning-lg',
      maxOutputTokens: 4096,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
    {
      task: 'navigator.tool_select',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 1024,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
    {
      task: 'support.reply',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
    {
      task: 'support.classify',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 256,
      price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
    },
    {
      task: 'scanner.rank',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
    {
      task: 'merchant.watch',
      providerId: 'primary',
      model: 'fast-sm',
      maxOutputTokens: 1024,
      price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
    },
    {
      task: 'copy_intel.stats',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
    {
      task: 'index.embed',
      providerId: 'primary',
      model: 'embed-sm',
      maxOutputTokens: 1,
      price: { inputPerMillion: '0.1', outputPerMillion: '0' },
      capability: 'embed',
    },
  ],
});

function billedRate(route: { price?: { inputPerMillion: bigint; outputPerMillion: bigint } }): string | undefined {
  if (!route.price) return undefined;
  return `${formatAmount(route.price.inputPerMillion)}/${formatAmount(route.price.outputPerMillion)}`;
}

describe('unset routing table', () => {
  it('does not bill placeholder per-million rates when AGENTS_ROUTING_TABLE is unset', () => {
    for (const raw of [undefined, '', '   '] as const) {
      const table = buildRoutingTable(raw, PLACEHOLDER_TABLE);
      let providerCalls = 0;
      for (const route of table.routes) {
        expect(billedRate(route), route.task).toBeUndefined();

        let caught: unknown;
        try {
          requireMeterPrice(route);
          providerCalls += 1;
        } catch (err) {
          caught = err;
        }

        expect(providerCalls, route.task).toBe(0);
        expect(caught, route.task).toBeInstanceOf(AgentError);
        expect(caught, route.task).toMatchObject({
          code: 'agents.price_not_configured',
          userMessageKey: 'agents.error.price_not_configured',
        });
      }
    }

    expect(PLACEHOLDER_TABLE.routes.every((route) => route.price !== undefined)).toBe(true);
  });

  it('meters a price configured as a decimal string', () => {
    const raw = JSON.stringify({
      routes: [
        {
          task: 'support.classify',
          providerId: 'primary',
          model: 'fast-sm',
          maxOutputTokens: 256,
          price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
        },
        {
          task: 'index.embed',
          providerId: 'primary',
          model: 'embed-sm',
          maxOutputTokens: 1,
          price: { inputPerMillion: '0.1', outputPerMillion: '0' },
          capability: 'embed',
        },
      ],
    });

    const table = buildRoutingTable(raw, PLACEHOLDER_TABLE);
    const classify = requireMeterPrice(table.routes[0]!);
    const embed = requireMeterPrice(table.routes[1]!);
    expect(formatAmount(usageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, classify))).toBe('1.5');
    expect(formatAmount(usageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, embed))).toBe('0.1');
  });

  it('leaves the shipped default table without placeholder rates', () => {
    expect(DEFAULT_ROUTING_TABLE.routes.some((route) => route.task === 'index.embed')).toBe(true);
    for (const route of DEFAULT_ROUTING_TABLE.routes) {
      expect(billedRate(route), route.task).toBeUndefined();
    }

    const table = buildRoutingTable(undefined, DEFAULT_ROUTING_TABLE);
    for (const route of table.routes) {
      expect(billedRate(route), route.task).toBeUndefined();
      expect(() => requireMeterPrice(route)).toThrow(AgentError);
    }
  });

  it('does not return the default table from boot when the routing env is unset', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('return DEFAULT_ROUTING_TABLE');
  });
});
