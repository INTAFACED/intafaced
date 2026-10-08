import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { usageCost } from '../metering/pricing.js';
import { DEFAULT_ROUTING_TABLE, parseRoutingTable, requireMeterPrice } from './routing.js';

/**
 * A route with no configured token price must refuse before anything is metered.
 * The shipped default table used to carry placeholder rates so a dev environment
 * would bill anyway. Those rates are not a price.
 */
describe('token price', () => {
  it('refuses to meter a blank price on the default table', () => {
    expect(DEFAULT_ROUTING_TABLE.routes.some((route) => route.task === 'index.embed')).toBe(true);

    for (const route of DEFAULT_ROUTING_TABLE.routes) {
      expect(route.price, route.task).toBeUndefined();

      let caught: unknown;
      try {
        requireMeterPrice(route);
      } catch (err) {
        caught = err;
      }

      expect(caught, route.task).toBeInstanceOf(AgentError);
      expect(caught, route.task).toMatchObject({
        code: 'agents.price_not_configured',
        userMessageKey: 'agents.error.price_not_configured',
      });
    }
  });

  it('meters a price that is configured as a decimal string', () => {
    const table = parseRoutingTable({
      routes: [
        {
          task: 'support.classify',
          providerId: 'primary',
          model: 'fast-sm',
          maxOutputTokens: 256,
          price: { inputPerMillion: '0.25', outputPerMillion: '1.25' },
        },
      ],
    });

    const price = requireMeterPrice(table.routes[0]!);
    // One million input tokens at 0.25 and one million output tokens at 1.25.
    expect(formatAmount(usageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price))).toBe('1.5');
  });

  it('meters a configured zero output rate and still refuses a blank one', () => {
    const configured = parseRoutingTable({
      routes: [
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
    const price = requireMeterPrice(configured.routes[0]!);
    expect(formatAmount(usageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price))).toBe('0.1');

    const blank = parseRoutingTable({
      routes: [
        {
          task: 'index.embed',
          providerId: 'primary',
          model: 'embed-sm',
          maxOutputTokens: 1,
          price: { inputPerMillion: '   ', outputPerMillion: '' },
          capability: 'embed',
        },
      ],
    });
    expect(blank.routes[0]!.price).toBeUndefined();
    expect(() => requireMeterPrice(blank.routes[0]!)).toThrow(AgentError);
  });
});
