import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../../shared/api';
import { createFuturesApi } from './api';

describe('createFuturesApi.close', () => {
  it('posts the position size and clientCloseId on /positions/:id/close', async () => {
    const rest = vi.fn(async (_path: string, _schema: unknown, _options?: { method?: string; body?: unknown }) => ({
      ok: true as const,
      data: { id: 'pos-1' },
    }));
    const api = createFuturesApi({ rest } as unknown as ApiClient);
    await api.close('pos-1', { quantity: '1.250', clientCloseId: 'close-abc' });
    expect(rest).toHaveBeenCalledTimes(1);
    const [path, , options] = rest.mock.calls[0] ?? [];
    expect(path).toBe('/positions/pos-1/close');
    expect(options).toEqual({
      method: 'POST',
      body: { quantity: '1.250', clientCloseId: 'close-abc' },
    });
  });
});
