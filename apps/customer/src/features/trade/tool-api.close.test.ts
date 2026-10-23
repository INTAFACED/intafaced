import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../shared/api';
import { createToolApi } from './tool-api';

describe('tool-api positionClose', () => {
  it('posts the position size and clientCloseId on /positions/:id/close', async () => {
    const rest = vi.fn(async (_path: string, _schema: unknown, _options?: { method?: string; body?: unknown }) => ({
      ok: true as const,
      data: { id: 'pos-9' },
    }));
    const api = { rest } as unknown as ApiClient;
    const tools = createToolApi(api);
    await tools.positionClose('pos-9', { quantity: '0.050', clientCloseId: 'click-1' });
    expect(rest).toHaveBeenCalledTimes(1);
    const [path, , options] = rest.mock.calls[0] ?? [];
    expect(path).toBe('/positions/pos-9/close');
    expect(options).toEqual({
      method: 'POST',
      body: { quantity: '0.050', clientCloseId: 'click-1' },
    });
  });
});
