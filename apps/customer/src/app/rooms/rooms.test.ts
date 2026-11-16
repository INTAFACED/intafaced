import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rooms } from '../navigation';
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
