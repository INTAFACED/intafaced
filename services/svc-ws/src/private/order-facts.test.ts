import { describe, expect, it } from 'vitest';
import { factFromOrderStatus, encodePrivateOrderFrame, encodePrivateFillFrame } from './order-facts.js';

describe('private order facts', () => {
  it('maps catalog statuses onto distinct ack/reject/fill/cancel facts', () => {
    expect(factFromOrderStatus('pending')).toBe('ack');
    expect(factFromOrderStatus('open')).toBe('ack');
    expect(factFromOrderStatus('rejected')).toBe('reject');
    expect(factFromOrderStatus('filled')).toBe('fill');
    expect(factFromOrderStatus('cancelled')).toBe('cancel');
    expect(factFromOrderStatus('expired')).toBe('expire');
  });

  it('names unknown status as unknown — never ack or fill', () => {
    for (const status of ['', 'unknown', 'success', 'OK', 'resting', 'partial', 'garbage']) {
      expect(factFromOrderStatus(status)).toBe('unknown');
      expect(factFromOrderStatus(status)).not.toBe('ack');
      expect(factFromOrderStatus(status)).not.toBe('fill');
    }
  });

  it('treats an inherited status name as unknown and still encodes fact', () => {
    expect(factFromOrderStatus('toString')).toBe('unknown');
    expect(factFromOrderStatus('constructor')).toBe('unknown');

    const toStringFrame = JSON.parse(encodePrivateOrderFrame({ status: 'toString' })) as Record<string, unknown>;
    expect(toStringFrame.fact).toBe('unknown');

    const constructorFrame = JSON.parse(encodePrivateOrderFrame({ status: 'constructor' })) as Record<string, unknown>;
    expect(constructorFrame.fact).toBe('unknown');
  });

  it('puts fact last on the wire so a payload status cannot be read as success', () => {
    const order = JSON.parse(
      encodePrivateOrderFrame({
        orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'rejected',
        type: 'limit',
        qty: '1',
      } as { readonly status: string }),
    ) as Record<string, unknown>;
    expect(order).toMatchObject({ channel: 'orders', fact: 'reject', status: 'rejected', type: 'limit' });
    expect(order.fact).not.toBe('ack');

    const unknown = JSON.parse(encodePrivateOrderFrame({ status: 'success', type: 'market' } as { readonly status: string })) as Record<
      string,
      unknown
    >;
    expect(unknown.fact).toBe('unknown');
    expect(unknown.status).toBe('success');

    const fill = JSON.parse(encodePrivateFillFrame({ fillId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', qty: '0.5' })) as Record<
      string,
      unknown
    >;
    expect(fill).toMatchObject({ channel: 'fills', fact: 'fill', qty: '0.5' });
  });
});
