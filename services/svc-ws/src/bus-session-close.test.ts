import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { attachBusHalf, closeBusSession } from './bus-session-close.js';
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

describe('late bus-half ownership', () => {
  it('cleans up a late attachment without announcing the closed session up', async () => {
    let finish!: (attachment: { id: string }) => void;
    let closed = false;
    const announce = vi.fn();
    const unsubscribe = vi.fn(async () => undefined);
    const installing = attachBusHalf({
      attach: () =>
        new Promise<{ id: string }>((resolve) => {
          finish = resolve;
        }),
      isClosed: () => closed,
      announce,
      unsubscribe,
    });
    closed = true;
    finish({ id: 'old-session' });
    expect(await installing).toBeNull();
    expect(announce).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledWith({ id: 'old-session' });
  });

  it('announces an owned attachment and refuses to begin another after closure', async () => {
    let closed = false;
    const attach = vi.fn(async () => ({ id: 'current-session' }));
    const announce = vi.fn();
    const unsubscribe = vi.fn(async () => undefined);
    const input = { attach, isClosed: () => closed, announce, unsubscribe };
    expect(await attachBusHalf(input)).toEqual({ id: 'current-session' });
    expect(announce).toHaveBeenCalledTimes(1);
    closed = true;
    expect(await attachBusHalf(input)).toBeNull();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });
});
