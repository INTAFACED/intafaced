import { trace, type Span } from '@opentelemetry/api';
import { partial } from '@intafaced/service-kit/testing';
import { describe, expect, it, vi } from 'vitest';
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
    // The booted service's log listener is index.db.test.ts ("the alert event is the active span event, and index
    // wires the log listener"). Here: the event lands on whatever span is active, named and with the signal's fields.
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const span: Span = partial<Span>({
      addEvent: (name: string, attributes?: Record<string, unknown>) => {
        events.push([name, attributes]);
        return span;
      },
    });
    const active = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
    try {
      emitCapturedOverCap(signal({ exceeded: ['daily_intake', 'single_payment'] }));
      active.mockReturnValue(undefined);
      expect(() => emitCapturedOverCap(signal())).not.toThrow();
    } finally {
      active.mockRestore();
    }
    expect(events).toEqual([
      [
        'payment.captured_over_cap',
        {
          'intafaced.payment_id': 'pay-1',
          'intafaced.merchant_id': 'mer-1',
          'intafaced.asset_id': 'USDT',
          'intafaced.amount': '10',
          'intafaced.exceeded': 'daily_intake,single_payment',
        },
      ],
    ]);
  });
});
