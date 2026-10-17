import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  capturedOverCapTotal,
  emitCapturedOverCap,
  onCapturedOverCap,
  resetCapturedOverCapTotalForTests,
  type CapturedOverCapSignal,
} from './over-cap-signal.js';

const signal = (over: Partial<CapturedOverCapSignal> = {}): CapturedOverCapSignal => ({
  paymentId: 'pay-1',
  merchantId: 'mer-1',
  assetCode: 'USDT',
  amount: '10',
  exceeded: ['daily_intake'],
  ...over,
});

describe('captured_over_cap signal', () => {
  it('counts each emit and delivers one alert to listeners', () => {
    resetCapturedOverCapTotalForTests();
    const seen: CapturedOverCapSignal[] = [];
    const stop = onCapturedOverCap((row) => seen.push(row));
    try {
      emitCapturedOverCap(signal());
      emitCapturedOverCap(signal({ paymentId: 'pay-2', exceeded: ['per_payment', 'monthly_intake'] }));
      expect(capturedOverCapTotal()).toBe(2);
      expect(seen.map((row) => row.paymentId)).toEqual(['pay-1', 'pay-2']);
      expect(seen[1]?.exceeded).toEqual(['per_payment', 'monthly_intake']);
    } finally {
      stop();
    }
  });

  it('a throwing listener does not stop the counter or the next listener', () => {
    resetCapturedOverCapTotalForTests();
    const seen: string[] = [];
    const stopBad = onCapturedOverCap(() => {
      throw new Error('log down');
    });
    const stopGood = onCapturedOverCap((row) => seen.push(row.paymentId));
    try {
      expect(() => emitCapturedOverCap(signal())).not.toThrow();
      expect(capturedOverCapTotal()).toBe(1);
      expect(seen).toEqual(['pay-1']);
    } finally {
      stopBad();
      stopGood();
    }
  });

  it('the alert event is the active span event, and index wires the log listener', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'over-cap-signal.ts'), 'utf8');
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(source).toContain("addEvent('payment.captured_over_cap'");
    expect(index).toContain('onCapturedOverCap(');
    expect(index).toContain("app.log.warn({ event: 'payment.captured_over_cap'");
  });
});
