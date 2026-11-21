import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentsGrowthMountVsTrackerBoardCard,
  agentsGrowthTrackerBackendDoneBarMet,
  GROWTH_MOUNTED_DOORS,
  GROWTH_TRACKER_ID,
  growthDoorsInRouterSource,
  growthDoorsInSource,
} from './mount-vs-tracker.js';

const routerSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'router.ts'), 'utf8');

const wrap = (body: string) => `export const appRouter = router({\n${body}\n});\n`;

describe('agents.growth mount vs tracker honest gaps (D26-P1-G1)', () => {
  it('backend done bar met on tip — proposals never publish', () => {
    expect(GROWTH_TRACKER_ID).toBe('agents.growth');
    expect(growthDoorsInRouterSource()).toEqual([...GROWTH_MOUNTED_DOORS]);
    expect(agentsGrowthTrackerBackendDoneBarMet()).toBe(true);
    expect(agentsGrowthMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
  });

  it('the actual router source mounts growth.propose and nothing else is read as the growth mount', () => {
    expect(growthDoorsInSource(routerSource)).toEqual(['propose']);
  });
});

describe('growth mount reader fixtures (#4551)', () => {
  it('a growth object without propose is not mounted, even when a sibling after it has propose', () => {
    const src = wrap(`
    growth: router({
      other: p.query(() => 1),
    }),
    merchant: router({
      propose: p.query(() => 1),
    }),`);
    expect(growthDoorsInSource(src)).toEqual([]);
  });

  it('a sibling before growth with propose does not count', () => {
    const src = wrap(`
    scanner: router({ propose: p.query(() => 1) }),
    growth: router({ other: p.query(() => 1) }),`);
    expect(growthDoorsInSource(src)).toEqual([]);
  });

  it('propose in a comment or string inside growth does not count', () => {
    const src = wrap(`
    growth: router({
      // propose: p.query(() => 1),
      /* propose: p.query(() => 1), */
      other: p.query(() => 'propose: x'),
      label: p.query(() => \`propose: \${1}\`),
    }),`);
    expect(growthDoorsInSource(src)).toEqual([]);
  });

  it('braces inside strings and comments do not end or extend the growth object', () => {
    const src = wrap(`
    growth: router({
      other: p.query(() => '}}) }'),
      // })
      propose: p.query(() => '{{'),
    }),
    later: router({ x: p.query(() => 1) }),`);
    expect(growthDoorsInSource(src)).toEqual(['propose']);
  });

  it('a propose nested deeper inside growth is not a growth door', () => {
    const src = wrap(`
    growth: router({
      inner: router({ propose: p.query(() => 1) }),
    }),`);
    expect(growthDoorsInSource(src)).toEqual([]);
  });

  it('an absent growth object is not mounted', () => {
    expect(growthDoorsInSource(wrap(`merchant: router({ propose: p.query(() => 1) }),`))).toEqual([]);
    expect(growthDoorsInSource(`const notes = "growth: router({ propose: x })";`)).toEqual([]);
  });

  it('an unclosed growth object cannot be claimed mounted', () => {
    const src = `export const appRouter = router({\n    growth: router({\n      propose: p.query(() => 1),\n`;
    expect(growthDoorsInSource(src)).toEqual([]);
  });

  it('the real router with its growth object cut short is not mounted', () => {
    const start = routerSource.indexOf('growth: router({');
    expect(start).toBeGreaterThan(-1);
    const cut = routerSource.slice(0, routerSource.indexOf('propose:', start) + 'propose:'.length + 40);
    expect(growthDoorsInSource(cut)).toEqual([]);
  });

  it('growth not sitting in a router({ ... }) object is not a mount', () => {
    expect(growthDoorsInSource(`const config = { growth: router({ propose: p.query(() => 1) }) };`)).toEqual([]);
  });
});
