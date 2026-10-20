import { describe, expect, it } from 'vitest';
import { features } from '../../../../app/feature-registry';
import { findRoom } from '../../../../app/navigation';
import { personalRoomFor, personalRooms } from './rooms';

// One sample address per room. The ids are TEST values.
const samples: Record<string, string> = {
  request: '/pay/request/req-1',
  scheduled: '/pay/scheduled',
  contacts: '/pay/contacts',
  group: '/pay/contacts/groups/g1',
  pool: '/pay/contacts/pools/p1',
  payment: '/pay/history/t1',
  claim: '/pay/claim/tok1',
  cases: '/pay/cases',
  case: '/pay/cases/c1',
  limits: '/pay/send/limits',
  fees: '/pay/fees',
  preferences: '/pay/preferences',
  scan: '/pay/scan',
  link: '/pay/l/l1',
  invoice: '/pay/bills/invoices/i1',
};

describe('personal Pay rooms (PP-order-02)', () => {
  it('has a sample for every room, so none is left untested', () => {
    expect(Object.keys(samples).sort()).toEqual(personalRooms.map((room) => room.id).sort());
  });

  it('opens each address as its own room, with the id from the address', () => {
    for (const room of personalRooms) {
      const match = personalRoomFor(samples[room.id]!);
      expect(match?.room.id, room.id).toBe(room.id);
    }
    expect(personalRoomFor('/pay/request/abc')?.params).toEqual({ requestId: 'abc' });
    expect(personalRoomFor('/pay/history/t1?x=1')?.params).toEqual({ transferId: 't1' });
    expect(personalRoomFor('/pay/contacts/')?.room.id).toBe('contacts');
  });

  it('is not a personal room for the plain tabs or the business rooms', () => {
    for (const path of ['/pay', '/pay/send', '/pay/receive', '/pay/request', '/pay/bills', '/pay/global', '/pay/merchant', '/pay/links/l1'])
      expect(personalRoomFor(path), path).toBeUndefined();
  });

  it('routes each address to the Pay screen, not the not-found row', () => {
    for (const room of personalRooms) {
      const row = findRoom(samples[room.id]!);
      expect(row?.screen, room.id).toBe('pay');
      expect(row?.title, room.id).not.toBe('Page not found');
    }
  });

  it('keeps the merchant rooms: no personal address shadows a business one', () => {
    for (const path of ['/pay/disputes', '/pay/limits', '/pay/settings', '/pay/invoices/inv-1', '/pay/payments/p1', '/pay/links/l1']) {
      const row = findRoom(path);
      expect(row?.screen, path).toBeUndefined();
      expect(row?.business, path).toBe(true);
    }
  });

  it('registers every room as reachable (blocked, never hidden) with a reason and an unlock', () => {
    for (const room of personalRooms) {
      const feature = features.find((row) => row.paths.includes(room.pattern));
      expect(feature, room.pattern).toBeDefined();
      expect(feature?.status, room.pattern).toBe('blocked');
      expect(feature?.tab, room.pattern).toBe('pay');
      expect(feature?.unlock, room.pattern).toContain(room.slice);
    }
  });
});
