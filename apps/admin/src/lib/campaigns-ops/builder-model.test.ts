import { describe, expect, it } from 'vitest';
import type { Campaign } from '@intafaced/contracts/campaigns-catalogue';
import { countsByState, definitionOf, movesFor, parseRegions, resumeStep } from './builder-model';

const draft = (over: Partial<Campaign> = {}): Campaign => ({
  id: 'cmp_1',
  name: 'TEST',
  type: 'task',
  state: 'draft',
  revision: 1,
  rules: '',
  startsAt: null,
  endsAt: null,
  timeZone: 'UTC',
  windows: { weekdays: null, hours: null },
  participation: null,
  budget: null,
  reward: null,
  tasks: null,
  createdBy: 'a',
  submittedBy: null,
  approvedBy: null,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
  ...over,
});

describe('campaign builder model', () => {
  it('a draft resumes at the first step that is still blank', () => {
    expect(resumeStep(draft())).toBe('basics');
    expect(resumeStep(draft({ rules: 'r' }))).toBe('who');
    const who = { exclusions: [], regionScope: 'listed' as const, restrictedRegions: null };
    expect(resumeStep(draft({ rules: 'r', participation: who }))).toBe('who');
    const listed = { ...who, restrictedRegions: ['KP'] };
    expect(resumeStep(draft({ rules: 'r', participation: listed }))).toBe('time');
    const timed = { rules: 'r', participation: listed, startsAt: '2026-10-25T00:00:00.000Z', endsAt: '2026-11-25T00:00:00.000Z' };
    expect(resumeStep(draft(timed))).toBe('money');
    expect(resumeStep(draft({ ...timed, budget: { asset: 'USDT', limit: '1', left: '1' } }))).toBe('money');
    expect(resumeStep(draft({ ...timed, budget: { asset: 'USDT', limit: '1', left: '1' }, reward: { asset: 'USDT', amount: '1' } }))).toBe(
      'review',
    );
  });

  it('the stored definition goes back whole, tasks included, with the budget limit and never what is left', () => {
    const tasks = { steps: [{ title: 't', event: 'trade.fill' as const, market: null, side: null, count: 1, streakDays: null }], claimWindowSeconds: 60, holdSeconds: 0, lock: null, kycGate: 'none' as const };
    const d = definitionOf(draft({ rules: 'r', budget: { asset: 'USDT', limit: '10', left: '4' }, tasks, windows: { weekdays: [1], hours: { from: '09:00', to: '17:00' } } }));
    expect(d).toMatchObject({ name: 'TEST', rules: 'r', budget: { asset: 'USDT', limit: '10' }, tasks, weekdays: [1], hours: { from: '09:00', to: '17:00' } });
    expect(d.budget).not.toHaveProperty('left');
  });

  it('counts come only from listed rows; none listed is no count at all', () => {
    expect(countsByState([])).toEqual([]);
    expect(countsByState([draft(), draft({ id: 'b' }), draft({ id: 'c', state: 'active' })])).toEqual([
      { state: 'draft', count: 2 },
      { state: 'active', count: 1 },
    ]);
  });

  it('region lists are two-letter codes, upper-cased and once each; anything else is named', () => {
    expect(parseRegions('kp, IR;kp  de')).toEqual({ ok: true, regions: ['KP', 'IR', 'DE'] });
    expect(parseRegions('')).toEqual({ ok: true, regions: [] });
    expect(parseRegions('DE, Iran')).toEqual({ ok: false, bad: 'Iran' });
  });

  it('offers only moves that can apply to the state', () => {
    expect(movesFor('draft')).toEqual(['submit', 'archive']);
    expect(movesFor('pending_approval')).toContain('approve');
    expect(movesFor('approved')).toContain('activate');
    expect(movesFor('archived')).toEqual([]);
  });
});
