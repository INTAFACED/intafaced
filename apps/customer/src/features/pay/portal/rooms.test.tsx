import { describe, expect, it, vi } from 'vitest';

// Server rendering has no external store snapshot for the language preference; read it directly.
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { rooms } from './rooms';
import { mergeRooms, type RoomDef } from './rooms-model';
import { moneyRooms } from './money/rooms';
import { paymentsRooms } from './payments/rooms';
import { settingsRooms } from './settings/rooms';
import { catalogRooms } from './catalog/rooms';
import { PORTAL_ROOMS } from './routes';

describe('portal room registry', () => {
  it('has exactly one owner for every room', () => {
    const owners = [moneyRooms, paymentsRooms, settingsRooms, catalogRooms].flatMap((table) => Object.keys(table));
    expect([...new Set(owners)].sort()).toEqual([...PORTAL_ROOMS].sort());
    expect(owners).toHaveLength(PORTAL_ROOMS.length);
    expect(Object.keys(rooms).sort()).toEqual([...PORTAL_ROOMS].sort());
  });
  it('refuses a room registered twice', () => {
    const def: RoomDef = { header: () => ({ title: 'x', purpose: 'y' }), render: () => null };
    expect(() => mergeRooms({ money: def }, { money: def })).toThrow(/registered twice/);
  });
  it('gives every room a title and a purpose in plain words', () => {
    for (const room of PORTAL_ROOMS) {
      const header = rooms[room].header({ room, param: 'TEST-id', step: room === 'onboarding' ? 'business' : undefined });
      expect(header.title, room).toBeTruthy();
      expect(header.purpose, room).toBeTruthy();
    }
  });
});
