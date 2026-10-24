import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../../shared/api';
import { createFuturesApi } from './api';

describe('createFuturesApi.setProtection', () => {
  function capture() {
    const rest = vi.fn(async (_path: string, _schema: unknown, _options?: { method?: string; body?: unknown }) => ({
      ok: true as const,
      data: { positionId: 'pos-1', takeProfit: null, stopLoss: null },
    }));
    return { rest, api: createFuturesApi({ rest } as unknown as ApiClient) };
  }

  it('sends a whole-position leg as a price and a part leg as { price, quantity }', async () => {
    const { rest, api } = capture();
    await api.setProtection({
      positionId: 'pos-1',
      takeProfit: '110',
      takeProfitQuantity: '0.004',
      stopLoss: '90',
      stopLossQuantity: null,
      clientRequestId: 'tpsl:abc',
    });
    const [path, , options] = rest.mock.calls[0] ?? [];
    expect(path).toBe('/positions/pos-1/protection');
    expect(options).toEqual({
      method: 'PUT',
      body: { takeProfit: { price: '110', quantity: '0.004' }, stopLoss: '90', clientRequestId: 'tpsl:abc' },
    });
  });

  it('leaves out a leg with no price, which clears it', async () => {
    const { rest, api } = capture();
    await api.setProtection({ positionId: 'pos-1', takeProfit: null, stopLoss: null, clientRequestId: 'tpsl:none' });
    expect(rest.mock.calls[0]?.[2]).toEqual({ method: 'PUT', body: { clientRequestId: 'tpsl:none' } });
  });
});
