import { describe, expect, it } from 'vitest';
import type { Campaign } from '@intafaced/contracts/campaigns-catalogue';
import {
  baseDefinition,
  blankSentence,
  definitionOf,
  editedView,
  isEditable,
  latestRevision,
  overviewOf,
  parseRegions,
  refusalSentence,
  resumeStep,
} from './builder-model';

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
  timeZoneBlank: false,
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
  pendingChange: null,
  earning: [],
  ...over,
});

describe('campaign builder model', () => {
  it('a draft resumes at the first tab that is still blank; parked tabs are never where it resumes', () => {
    expect(resumeStep(draft({ name: ' ' }))).toBe('basics');
    expect(resumeStep(draft())).toBe('who');
    const who = { exclusions: [], regionScope: 'listed' as const, restrictedRegions: null };
    expect(resumeStep(draft({ participation: who }))).toBe('who');
    expect(resumeStep(draft({ participation: { ...who, restrictedRegions: ['KP'] } }))).toBe('time');
    expect(resumeStep(draft({ participation: { ...who, regionScope: 'platform' } }))).toBe('time');
  });

  it('the stored definition goes back whole, tasks included, with the budget limit and never what is left', () => {
    const tasks = {
      steps: [{ title: 't', event: 'trade.fill' as const, market: null, side: null, count: 1, streakDays: null }],
      claimWindowSeconds: 60,
      holdSeconds: 0,
      lock: null,
      kycGate: 'none' as const,
    };
    const d = definitionOf(
      draft({
        rules: 'r',
        budget: { asset: 'USDT', limit: '10', left: '4' },
        tasks,
        windows: { weekdays: [1], hours: { from: '09:00', to: '17:00' } },
      }),
    );
    expect(d).toMatchObject({
      name: 'TEST',
      rules: 'r',
      budget: { asset: 'USDT', limit: '10' },
      tasks,
      weekdays: [1],
      hours: { from: '09:00', to: '17:00' },
    });
    expect(d.budget).not.toHaveProperty('left');
  });

  it('the overview counts only listed rows', () => {
    expect(overviewOf([]).every((f) => f.count === 0)).toBe(true);
    const counts = overviewOf([draft(), draft({ id: 'b', state: 'pending_approval' }), draft({ id: 'c', state: 'scheduled' })]);
    expect(counts).toEqual([
      { label: 'Campaigns', count: 3 },
      { label: 'Drafts', count: 1 },
      { label: 'Waiting for approval', count: 1 },
      { label: 'Approved, not live yet', count: 0 },
      { label: 'Live or scheduled', count: 1 },
      { label: 'Ended', count: 0 },
    ]);
  });

  it('region lists are two-letter codes, upper-cased and once each; anything else is named', () => {
    expect(parseRegions('kp, IR;kp  de')).toEqual({ ok: true, regions: ['KP', 'IR', 'DE'] });
    expect(parseRegions('')).toEqual({ ok: true, regions: [] });
    expect(parseRegions('DE, Iran')).toEqual({ ok: false, bad: 'Iran' });
  });

  it('names each blank with its code, and who may not approve', () => {
    expect(blankSentence({ code: 'campaigns.region_list_unset', field: 'restrictedRegions' })).toBe(
      'The region list is not set (campaigns.region_list_unset)',
    );
    const asked = draft({ state: 'pending_approval', submittedBy: 'a' });
    expect(refusalSentence('campaigns.second_person_required', asked, 'a')).toBe('You asked for this, so another founder must approve it.');
    expect(refusalSentence('campaigns.second_person_required', { ...asked, submittedBy: 'b' }, 'a')).toMatch(/You wrote this draft/);
    expect(refusalSentence('campaign.archive_active', asked, 'a')).toMatch(/^An active campaign cannot be archived/);
    expect(refusalSentence('campaign.unknown', asked, 'a')).toBeNull();
  });

  it('a time zone the builder left blank goes back blank; any other is the platform zone', () => {
    expect(definitionOf(draft({ timeZone: null, timeZoneBlank: true })).timeZone).toBeNull();
    expect(definitionOf(draft({ timeZone: null })).timeZone).toBeUndefined();
  });

  it('a live campaign is edited through its open change; the change is what the builder shows and saves over', () => {
    expect(isEditable(draft({ state: 'active' }))).toBe(true);
    expect(isEditable(draft({ state: 'pending_approval' }))).toBe(false);
    expect(isEditable(draft({ state: 'ended' }))).toBe(false);
    const live = draft({ state: 'active', revision: 3, rules: 'live', budget: { asset: 'USDT', limit: '100', left: '90' } });
    expect(latestRevision(live)).toBe(3);
    expect(baseDefinition(live).rules).toBe('live');
    const definition = { name: 'TEST', type: 'task', rules: 'next', budget: { asset: 'USDT', limit: '120' }, timeZone: null };
    const changed = draft({
      ...live,
      pendingChange: { revision: 4, state: 'draft', createdBy: 'a', submittedBy: null, definition, updatedAt: live.updatedAt },
    });
    expect(latestRevision(changed)).toBe(4);
    expect(baseDefinition(changed)).toBe(definition);
    expect(editedView(changed)).toMatchObject({ revision: 3, rules: 'next', timeZoneBlank: true, budget: { limit: '120', left: '90' } });
    expect(refusalSentence('campaigns.second_person_required', changed, 'a')).toBe(
      'You wrote this revision, so another founder must approve it.',
    );
  });
});
