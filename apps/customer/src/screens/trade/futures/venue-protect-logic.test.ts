import { describe, expect, it } from 'vitest';
import { PROTECTION_FIELDS, canonical, closingSide, coverage, protectionClientId, whereItRests } from './venue-protect-logic';

describe('whereItRests', () => {
  const both = ['mark', 'last'] as const;
  it('rests on the venue when the venue judges triggers on the source, for every kind but a trailing stop', () => {
    for (const kind of ['take_profit', 'stop_loss', 'stop_market', 'stop_limit'] as const) {
      expect(whereItRests(kind, 'mark', both)).toBe('venue');
      expect(whereItRests(kind, 'last', both)).toBe('venue');
    }
  });
  it('runs on our engine for a trailing stop, or a stop market on the index or a mark the venue does not judge', () => {
    expect(whereItRests('trailing_stop', 'mark', both)).toBe('engine');
    expect(whereItRests('trailing_stop', 'index', both)).toBe('engine');
    expect(whereItRests('stop_market', 'index', both)).toBe('engine');
    expect(whereItRests('stop_market', 'mark', [])).toBe('engine');
  });
  it('is offered nowhere when neither the venue nor the engine judges it', () => {
    expect(whereItRests('trailing_stop', 'last', both)).toBe('none');
    expect(whereItRests('take_profit', 'index', both)).toBe('none');
    expect(whereItRests('stop_limit', 'index', both)).toBe('none');
    expect(whereItRests('take_profit', 'mark', undefined)).toBe('none');
  });
});

describe('coverage', () => {
  it('names the part a size covers and the rest it leaves, exactly', () => {
    expect(coverage('0.4', '1')).toEqual({ whole: false, covers: '0.4', of: '1', rest: '0.6' });
    expect(coverage('1', '1.5')).toEqual({ whole: false, covers: '1', of: '1.5', rest: '0.5' });
  });
  it('covers the whole position at or above its size', () => {
    expect(coverage('1', '1.0')).toEqual({ whole: true });
    expect(coverage('2', '1')).toEqual({ whole: true });
  });
  it('is unreadable for a blank, zero or malformed size', () => {
    expect(coverage('', '1')).toBeNull();
    expect(coverage('0', '1')).toBeNull();
    expect(coverage('abc', '1')).toBeNull();
    expect(coverage('1', '0')).toBeNull();
  });
});

describe('fields, sides and ids', () => {
  it('each kind takes only its own price fields', () => {
    expect(PROTECTION_FIELDS.take_profit).toEqual(['triggerPrice']);
    expect(PROTECTION_FIELDS.stop_limit).toEqual(['triggerPrice', 'limitPrice']);
    expect(PROTECTION_FIELDS.trailing_stop).toEqual(['trailingDistance']);
  });
  it('closes a long with a sell and a short with a buy', () => {
    expect(closingSide('long')).toBe('sell');
    expect(closingSide('short')).toBe('buy');
  });
  it('shows decimals canonically and keeps text that is not one', () => {
    expect(canonical('1.50')).toBe('1.5');
    expect(canonical(' 3100 ')).toBe('3100');
    expect(canonical('x')).toBe('x');
  });
  it('mints a client id the door accepts, new per press', () => {
    const a = protectionClientId(1_700_000_000_000, 0);
    const b = protectionClientId(1_700_000_000_000, 1);
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(a).not.toBe(b);
  });
});
