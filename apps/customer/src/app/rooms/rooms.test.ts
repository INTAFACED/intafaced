import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rooms } from '../navigation';
import { sharedNavigationCopy } from '../navigation-copy';
import type { Area, Room } from './room';

// One shared room table was edited by 18 merged PRs in 7 days (project-state #2616): every journey that added a room
// edited the same lines. The rows live in one file per area; navigation.ts only joins them.
const here = fileURLToPath(new URL('.', import.meta.url));
const AREAS: readonly Area[] = ['public', 'home', 'money', 'trade', 'pay', 'more', 'person', 'team', 'web3'];

describe('the room table, one file per area', () => {
  it('declares no room row in navigation.ts', () => {
    const source = readFileSync(new URL('../navigation.ts', import.meta.url), 'utf8');
    // A room row is `{ path, title, ... }`; the five doors (`{ name, path }`) are not rooms.
    const rows = [...source.matchAll(/\{\s*path:\s*['`]\/[^'`]*['`],\s*title:/g)].map((m) => m[0]);
    expect(rows, "add a room to its area's file, src/app/rooms/<area>.ts, never to navigation.ts").toEqual([]);
  });

  it('has one file per area, and each file holds only that area', async () => {
    const files = readdirSync(here)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && f !== 'room.ts')
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    expect(files).toEqual([...AREAS].sort());
    for (const area of AREAS) {
      const module = (await import(`./${area}.ts`)) as Record<string, readonly Room[]>;
      const list = module[`${area}Rooms`];
      expect(list?.length, `${area}.ts exports ${area}Rooms`).toBeGreaterThan(0);
      expect(
        list!.filter((room) => room.area !== area).map((room) => room.path),
        `rows in ${area}.ts of another area`,
      ).toEqual([]);
    }
  });

  it('joins the areas in order, so lookup and search meet each area as one run', () => {
    const runs = rooms.map((room) => room.area).filter((area, i, all) => area !== all[i - 1]);
    expect(runs).toEqual(AREAS);
  });
});

// The labels followed the same path: one shared catalog of every room's title and description was edited by 16 merged
// PRs in 7 days (project-state #2617). Each area's labels live beside its rows (`<area>Copy`); `areaRooms` types a row's
// labels to its own area's copy or the shared one, and this holds the shared one to labels no single area owns.
describe('the room labels, one copy per area', () => {
  it('keeps in navigation-copy.ts only the labels no single area owns', () => {
    const areasOf = new Map<string, Set<Area>>();
    for (const room of rooms)
      for (const key of [room.title, room.description]) areasOf.set(key, (areasOf.get(key) ?? new Set()).add(room.area));
    const owned = Object.keys(sharedNavigationCopy.en).flatMap((key) => {
      const areas = [...(areasOf.get(key) ?? [])];
      return areas.length === 1 ? [`${key} (${areas[0]})`] : [];
    });
    expect(owned, "write a room's labels in its area's copy, `<area>Copy` in src/app/rooms/<area>.ts, never in navigation-copy.ts").toEqual(
      [],
    );
  });

  it('has every area file export its copy beside its rows', async () => {
    for (const area of AREAS) {
      const module = (await import(`./${area}.ts`)) as Record<string, { en?: Record<string, string> }>;
      expect(Object.keys(module[`${area}Copy`]?.en ?? {}).length, `${area}.ts exports ${area}Copy`).toBeGreaterThan(0);
    }
  });
});
