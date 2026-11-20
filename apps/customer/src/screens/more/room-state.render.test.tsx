import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { MoreHub } from './index';
import { LIVE_ROOMS, PARKED_ROOMS, type LiveState, type RoomState } from './room-state';

const states = (live: Partial<Record<keyof typeof LIVE_ROOMS, LiveState>> = {}): Record<string, RoomState> => ({
  ...Object.fromEntries(Object.keys(LIVE_ROOMS).map((id) => [id, { kind: 'live', state: live[id as keyof typeof LIVE_ROOMS] ?? 'open' }])),
  ...Object.fromEntries(Object.entries(PARKED_ROOMS).map(([id, blocker]) => [id, { kind: 'parked', blocker }])),
});
const stateOf = (out: string, id: string) =>
  out.match(new RegExp(`data-tile="${id}"[\\s\\S]*?<span data-testid="more-tile__state"([^>]*)>([\\s\\S]*?)</span></span></a>`));

// J-more-catalogue-01 #1: the six rooms are listed with their real state, none hidden.
describe('More room states', () => {
  it('Market, Launch and Token say what their service answers now, and only the six room tiles carry a state', () => {
    const out = renderToStaticMarkup(<MoreHub states={states({ market: 'not_answering', launch: 'checking' })} />);
    expect(out.match(/data-testid="more-tile__state"/g)).toHaveLength(6);
    expect(stateOf(out, 'token')?.[1]).toContain('data-state="open"');
    expect(stateOf(out, 'token')?.[2]).toBe('Open: its service answers');
    expect(stateOf(out, 'market')?.[1]).toContain('data-state="not_answering"');
    expect(stateOf(out, 'market')?.[2]).toBe('Not answering right now');
    expect(stateOf(out, 'launch')?.[2]).toBe('Checking the service');
    for (const id of Object.keys(LIVE_ROOMS)) expect(stateOf(out, id)?.[1]).not.toContain('data-blocker');
    expect(out).not.toMatch(/data-tile="academy"[^]*?more-tile__state[^]*?data-tile="agents"/);
  });

  it('Predict, Mining and Blueprint are listed as parked, each with what it waits on', () => {
    const out = renderToStaticMarkup(<MoreHub states={states()} />);
    expect(stateOf(out, 'predict')?.[1]).toContain('data-state="parked" data-blocker="owner.decision"');
    expect(stateOf(out, 'predict')?.[2]).toBe('Parked: how a result settles waits on an owner decision');
    for (const id of ['mining', 'blueprint']) {
      expect(stateOf(out, id)?.[1]).toContain('data-state="parked" data-blocker="after.launch"');
      expect(stateOf(out, id)?.[2]).toBe('Parked until after launch');
    }
    expect(out.match(/data-blocker=/g)).toHaveLength(3);
  });

  it('every open room maps to the edge module its room reads', () => {
    expect(LIVE_ROOMS).toEqual({ market: 'market', launch: 'token', token: 'token' });
  });
});
