import { describe, expect, it } from 'vitest';
import { serviceHealthSchema } from './service-health.js';

describe('serviceHealthSchema', () => {
  it('accepts a live answer and refuses anything else', () => {
    expect(serviceHealthSchema.safeParse({ ok: true, service: 'svc-token' }).success).toBe(true);
    expect(serviceHealthSchema.safeParse({ ok: false, service: 'svc-token' }).success).toBe(false);
    expect(serviceHealthSchema.safeParse({ ok: true }).success).toBe(false);
    expect(serviceHealthSchema.safeParse(null).success).toBe(false);
  });
});
