import { describe, expect, it } from 'vitest';
import { findRoom } from '../../app/navigation';
import { DOOR_ORDER, doorSummaries, roomsForDoor } from './public-catalogue';

describe('public catalogue', () => {
  it('lists real rooms only: each path resolves to a room behind that door, once, with words', () => {
    for (const door of DOOR_ORDER) {
      const entries = roomsForDoor(door);
      expect(entries.length).toBeGreaterThan(0);
      expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
      for (const entry of entries) {
        const room = findRoom(entry.path);
        expect(room?.door).toBe(door);
        expect(room?.alias).toBeUndefined();
        expect(entry.title.trim()).not.toBe('');
        expect(entry.description.trim()).not.toBe('');
      }
    }
  });

  it('leaves out detail pages, business-only rooms and parked protocol rooms', () => {
    const everything = DOOR_ORDER.flatMap((door) => roomsForDoor(door).map((entry) => entry.path));
    expect(everything.some((path) => path.includes(':'))).toBe(false);
    expect(everything).not.toContain('/chain');
    expect(everything).not.toContain('/pay/merchant');
  });

  it('counts what it lists', () => {
    for (const summary of doorSummaries()) expect(summary.count).toBe(summary.entries.length);
  });

  it('puts the support desk and the prediction markets under More', () => {
    const more = roomsForDoor('More').map((entry) => entry.path);
    expect(more).toContain('/support');
    expect(more).toContain('/predict');
  });
});
