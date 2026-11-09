import { describe, expect, it } from 'vitest';
import { chooseAgent, eligible, type Candidate } from './desk-routing.js';

const NOW = Date.parse('2026-11-06T10:00:00.000Z');
const agent = (userId: string, over: Partial<Candidate> = {}): Candidate => ({
  userId,
  availability: 'online',
  lastHeartbeatAt: '2026-11-06T09:59:50.000Z',
  capacity: 5,
  skills: [],
  load: 0,
  ...over,
});
const pick = (candidates: Candidate[], over: Partial<Parameters<typeof chooseAgent>[1]> = {}) =>
  chooseAgent(candidates, {
    mode: 'round_robin',
    cursorUserId: null,
    requiredSkill: null,
    nowMs: NOW,
    heartbeatWindowSeconds: null,
    ...over,
  })?.userId ?? null;

describe('routing candidates (SP-routing-01)', () => {
  it('skips an agent who is busy, offline, silent past the window, at capacity, with a blank capacity, or without the skill', () => {
    expect(eligible(agent('a'), null, NOW, null)).toBe(true);
    expect(eligible(agent('a', { availability: 'busy' }), null, NOW, null)).toBe(false);
    expect(eligible(agent('a', { availability: 'offline' }), null, NOW, null)).toBe(false);
    expect(eligible(agent('a', { lastHeartbeatAt: '2026-11-06T09:59:00.000Z' }), null, NOW, 30)).toBe(false);
    expect(eligible(agent('a', { lastHeartbeatAt: null }), null, NOW, 30)).toBe(false);
    expect(eligible(agent('a', { lastHeartbeatAt: null }), null, NOW, null)).toBe(true);
    expect(eligible(agent('a', { capacity: 2, load: 2 }), null, NOW, null)).toBe(false);
    expect(eligible(agent('a', { capacity: null }), null, NOW, null)).toBe(false);
    expect(eligible(agent('a', { capacity: 0 }), null, NOW, null)).toBe(false);
    expect(eligible(agent('a', { skills: ['fx'] }), 'fx', NOW, null)).toBe(true);
    expect(eligible(agent('a'), 'fx', NOW, null)).toBe(false);
  });

  it('goes round in turn from the stored cursor, wrapping, and skips who cannot take it', () => {
    const three = [agent('c'), agent('a'), agent('b')];
    expect(pick(three)).toBe('a');
    expect(pick(three, { cursorUserId: 'a' })).toBe('b');
    expect(pick(three, { cursorUserId: 'b' })).toBe('c');
    expect(pick(three, { cursorUserId: 'c' })).toBe('a');
    // A cursor naming someone no longer in the group still moves on to the next id.
    expect(pick(three, { cursorUserId: 'bb' })).toBe('c');
    expect(pick([agent('a'), agent('b', { capacity: null }), agent('c')], { cursorUserId: 'a' })).toBe('c');
  });

  it('gives the least loaded agent the request, ties broken in turn', () => {
    const loads = [agent('a', { load: 2 }), agent('b', { load: 1 }), agent('c', { load: 1 })];
    expect(pick(loads, { mode: 'load_balanced' })).toBe('b');
    expect(pick(loads, { mode: 'load_balanced', cursorUserId: 'b' })).toBe('c');
  });

  it('answers no agent when nobody may take it, including a skill nobody has', () => {
    expect(pick([])).toBeNull();
    expect(pick([agent('a'), agent('b')], { requiredSkill: 'nobody-has-this' })).toBeNull();
  });
});
