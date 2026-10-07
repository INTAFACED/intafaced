import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeBusSession } from './bus-session-close.js';
import { DropCopyHub } from './drop-copy/hub.js';
import { PrivateOrderHub } from './private/hub.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sink() {
  const sent: string[] = [];
  return {
    sent,
    get bufferedBytes() {
      return 0;
    },
    send(frame: string) {
      sent.push(frame);
    },
    close() {
      /* seat stays up; the bus close does not drop it */
    },
  };
}

function latestReadyBus(sent: readonly string[], channel: string): boolean | undefined {
  const ready = sent
    .map((frame) => JSON.parse(frame) as { type?: string; channel?: string; bus?: boolean })
    .filter((frame) => frame.type === 'ready' && frame.channel === channel);
  return ready.at(-1)?.bus;
}

describe('bus session close', () => {
  it('after the bus session closes, the private hub is not still advertising the bus as up', async () => {
    const privateHub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
    });
    const dropCopyHub = new DropCopyHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
      recentLimit: 10,
    });
    const seat = sink();
    expect(privateHub.attach(USER, seat)).not.toBeNull();
    privateHub.announceBus(true);
    dropCopyHub.announceBus(true);
    expect(latestReadyBus(seat.sent, 'orders')).toBe(true);
    expect(latestReadyBus(seat.sent, 'fills')).toBe(true);
    expect(latestReadyBus(seat.sent, 'positions')).toBe(true);

    const removed: string[] = [];
    await closeBusSession({
      privateHub,
      dropCopyHub,
      unsubscribe: [
        async () => {
          removed.push('orders');
        },
        async () => {
          removed.push('fills');
        },
        async () => {
          removed.push('positions');
        },
      ],
      disconnect: async () => {
        removed.push('bus');
      },
    });

    expect(privateHub.connections).toBe(1);
    expect(latestReadyBus(seat.sent, 'orders')).toBe(false);
    expect(latestReadyBus(seat.sent, 'fills')).toBe(false);
    expect(latestReadyBus(seat.sent, 'positions')).toBe(false);
    expect(dropCopyHub.busAttached).toBe(false);
    expect(removed).toEqual(['orders', 'fills', 'positions', 'bus']);

    privateHub.announceBus(true);
    expect(latestReadyBus(seat.sent, 'orders')).toBe(true);
    expect(latestReadyBus(seat.sent, 'fills')).toBe(true);
    expect(latestReadyBus(seat.sent, 'positions')).toBe(true);

    const indexSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const closeAt = indexSrc.lastIndexOf('close: async () => {');
    expect(closeAt).toBeGreaterThan(-1);
    const closeBody = indexSrc.slice(closeAt, indexSrc.indexOf('},', closeAt));
    expect(closeBody).toContain('closeBusSession');
    expect(closeBody).toContain('privateHub: privateOrderHub');
  });
});
