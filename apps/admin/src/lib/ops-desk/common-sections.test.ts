import { describe, expect, it } from 'vitest';
import { DESKS, MINING_DESK } from './catalog';
import { COMMON_SECTION_IDS, COMMON_SECTION_SETS, exportableSections, resolveCommonSections, type CommonDeskId } from './common-sections';
import type { ModuleId } from '@intafaced/config';
import { killRefusalFor } from '@/lib/desk/module-kill-model';
import type { DeskSpec } from './types';

const DESK_FOR: Record<CommonDeskId, DeskSpec | null> = {
  bank: DESKS.bank,
  pay: DESKS.pay,
  academy: DESKS.academy,
  mining: MINING_DESK,
  predict: null,
};
const SETS = Object.keys(DESK_FOR) as CommonDeskId[];

describe('the common eight sections (OPS-founder-01)', () => {
  it.each(SETS)('%s: all eight render, in order, and every desk section named exists', (id) => {
    const resolved = resolveCommonSections(id, DESK_FOR[id]);
    expect(resolved.map((s) => s.id)).toEqual([...COMMON_SECTION_IDS]);
    for (const s of resolved) {
      if (s.fill.kind === 'wired') expect(s.fill.sections.length + (s.fill.links?.length ?? 0)).toBeGreaterThan(0);
      else expect(s.fill.blocker.length).toBeGreaterThan(20);
    }
  });

  it('bank, pay and academy desks carry their set, and mining has its own desk', () => {
    expect(DESKS.bank.commonSet).toBe('bank');
    expect(DESKS.pay.commonSet).toBe('pay');
    expect(DESKS.academy.commonSet).toBe('academy');
    expect(MINING_DESK.commonSet).toBe('mining');
    expect(MINING_DESK.sections.map((s) => s.id)).toEqual(['mining']);
    // Same API as More modules: the mining desk is a view of that read, not a second copy of it.
    expect(MINING_DESK.id).toBe('more');
    expect(MINING_DESK.endpoint).toBe(DESKS.more.endpoint);
  });

  it('predict has no service, so every section is unwired and names that blocker', () => {
    for (const s of resolveCommonSections('predict', null)) {
      expect(s.fill.kind).toBe('unwired');
      if (s.fill.kind === 'unwired') expect(s.fill.blocker).toMatch(/No Predict service/);
    }
  });

  it('exports are worked out from the desk: every section with a list, and nothing else', () => {
    for (const id of SETS) {
      const desk = DESK_FOR[id];
      const exportsFill = resolveCommonSections(id, desk).find((s) => s.id === 'exports')!.fill;
      const expected = exportableSections(desk);
      if (expected.length === 0) expect(exportsFill.kind).toBe('unwired');
      else expect(exportsFill).toMatchObject({ kind: 'wired', sections: expected });
    }
    expect(exportableSections(DESKS.bank)).toContain('pools');
    expect(exportableSections(DESKS.bank)).not.toContain('service');
  });

  it('a set naming a desk section that does not exist throws rather than link to nothing', () => {
    const renamed: DeskSpec = { ...DESKS.bank, sections: DESKS.bank.sections.filter((s) => s.id !== 'loans') };
    expect(() => resolveCommonSections('bank', renamed)).toThrow(/loans/);
  });

  it('every halt that is wired points at the module board for a module the edge enforces', () => {
    expect(COMMON_SECTION_SETS.mining.halt).toMatchObject({ kind: 'wired', links: [{ href: '/#module=mining-pool' }] });
    expect(COMMON_SECTION_SETS.bank.halt).toMatchObject({ kind: 'wired', links: [{ href: '/#module=bank' }] });
    for (const id of SETS) {
      const halt = COMMON_SECTION_SETS[id].halt;
      if (halt.kind !== 'wired') continue;
      for (const link of halt.links ?? []) {
        const module = link.href.replace('/#module=', '') as ModuleId;
        expect(killRefusalFor(module), `${id}: ${module}`).toBeNull();
      }
    }
  });
});
