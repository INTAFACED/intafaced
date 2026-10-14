import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, effectiveOptions, postOnlyAllowed, TIF_VALUES } from './options';

describe('time in force and post-only', () => {
  it('offers only what the spot order API accepts: GTC, IOC, FOK (GTD and GTT cannot be sent)', () => {
    expect(TIF_VALUES).toEqual(['GTC', 'IOC', 'FOK']);
  });

  it('a market order always keeps the old fixed values', () => {
    expect(effectiveOptions('market', { timeInForce: 'FOK', postOnly: true })).toEqual(DEFAULT_OPTIONS);
  });

  it('a limit order carries the chosen values', () => {
    expect(effectiveOptions('limit', { timeInForce: 'IOC', postOnly: false })).toEqual({ timeInForce: 'IOC', postOnly: false });
    expect(effectiveOptions('limit', { timeInForce: 'GTC', postOnly: true })).toEqual({ timeInForce: 'GTC', postOnly: true });
  });

  it('post-only is dropped with IOC or FOK instead of being sent for the service to refuse', () => {
    expect(effectiveOptions('limit', { timeInForce: 'IOC', postOnly: true }).postOnly).toBe(false);
    expect(effectiveOptions('limit', { timeInForce: 'FOK', postOnly: true }).postOnly).toBe(false);
    expect(postOnlyAllowed('GTC')).toBe(true);
    expect(postOnlyAllowed('IOC')).toBe(false);
    expect(postOnlyAllowed('FOK')).toBe(false);
  });
});
