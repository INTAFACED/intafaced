import { describe, expect, it } from 'vitest';
import { idempotencyHeaders } from './idempotency-headers.js';

const upstream = (h: Record<string, string>) => ({ get: (name: string) => h[name] ?? null });

describe('idempotency answers pass through on the venue door only (J-developer-05)', () => {
  it('forwards idempotent-replayed and a whole-second retry-after on /api/v1/venue/', () => {
    expect(idempotencyHeaders('/api/v1/venue/submit', upstream({ 'idempotent-replayed': 'true', 'retry-after': '1' }))).toEqual({
      'idempotent-replayed': 'true',
      'retry-after': '1',
    });
  });

  it('forwards nothing elsewhere, and nothing malformed', () => {
    expect(idempotencyHeaders('/api/v1/orders', upstream({ 'idempotent-replayed': 'true', 'retry-after': '1' }))).toEqual({});
    expect(idempotencyHeaders('/api/v1/venue/submit', upstream({ 'idempotent-replayed': 'yes', 'retry-after': 'soon' }))).toEqual({});
    expect(idempotencyHeaders('/api/v1/venue/submit', upstream({ 'retry-after': '1\r\nx: y' }))).toEqual({});
  });
});
