import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { MoreHub } from './index';
import { ROOM_SERVICES, type RoomState } from './room-state';

const ROOMS = Object.keys(ROOM_SERVICES);
const all = (state: RoomState) => Object.fromEntries(ROOMS.map((id) => [id, state]));
const stateOf = (out: string, id: string) =>
  out.match(new RegExp(`data-tile="${id}"[\\s\\S]*?<span class="more-tile__state"([^>]*)>([\\s\\S]*?)</span></span></a>`));

// J-more-catalogue-01 #1: the six rooms are listed with their real state, none hidden.
describe('More room states', () => {
  it('each of the six room tiles shows its service state, and only those six carry one', () => {
    const out = renderToStaticMarkup(<MoreHub states={{ ...all('open'), market: 'not_answering', mining: 'checking' }} />);
    expect(out.match(/class="more-tile__state"/g)).toHaveLength(6);
    expect(stateOf(out, 'launch')?.[1]).toContain('data-state="open"');
    expect(stateOf(out, 'launch')?.[2]).toBe('Open: its service answers');
    expect(stateOf(out, 'market')?.[1]).toContain('data-state="not_answering"');
    expect(stateOf(out, 'market')?.[2]).toBe('Not answering right now');
    expect(stateOf(out, 'mining')?.[2]).toBe('Checking the service');
    expect(out).not.toMatch(/data-tile="academy"[^]*?more-tile__state[^]*?data-tile="agents"/);
  });

  it('Predict names its owner.decision blocker whatever its service answers; no other room names one', () => {
    for (const state of ['open', 'not_answering'] as const) {
      const out = renderToStaticMarkup(<MoreHub states={all(state)} />);
      const predict = stateOf(out, 'predict');
      expect(predict?.[1]).toContain('data-blocker="owner.decision"');
      expect(predict?.[2]).toContain('Publishing waits on an owner decision');
      expect(predict?.[2]).toContain('<code lang="zxx">owner.decision</code>');
      expect(out.match(/data-blocker=/g)).toHaveLength(1);
    }
  });

  it('every More room tile maps to the edge module its room reads', () => {
    expect(ROOM_SERVICES).toEqual({
      predict: 'trade',
      market: 'market',
      launch: 'token',
      token: 'token',
      mining: 'mining',
      blueprint: 'blueprint',
    });
  });
});
