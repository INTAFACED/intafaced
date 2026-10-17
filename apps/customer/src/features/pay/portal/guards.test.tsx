import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { newRequestId } from './model';
import { MoneyText } from './ui/MoneyText';

describe('request ids', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('makes a v4-shaped id from the browser', () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('builds one from random bytes when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (b: Uint8Array) => {
        b.fill(7);
        return b;
      },
    });
    expect(newRequestId()).toMatch(/^07070707-0707-4707-8707-070707070707$/);
  });
  it('throws without any crypto, never an all-zero id', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => newRequestId()).toThrow();
    vi.stubGlobal('crypto', {});
    expect(() => newRequestId()).toThrow();
  });
});

describe('money text', () => {
  it('hides a zero line when asked', () => {
    expect(renderToString(<MoneyText value="0.00" asset="USDT" hideZero />)).toBe('');
  });
  it('does not crash on an amount that is not one, with or without hideZero', () => {
    expect(() => renderToString(<MoneyText value="not-a-number" asset="USDT" hideZero />)).not.toThrow();
    expect(() => renderToString(<MoneyText value="" asset="USDT" hideZero />)).not.toThrow();
    expect(renderToString(<MoneyText value="1e9" asset="USDT" hideZero />)).toContain('—');
  });
});
