import { describe, expect, it } from 'vitest';
import { NATIVE, payInRefusal, payInTokens } from './fee-token';

const token = (address: string, name: string) => ({ address, name, symbol: name, decimals: 6 });

describe('paying the network fee in a token', () => {
  it('reads each relay refusal by name, and anything else as unread', () => {
    expect(payInRefusal('protocol.fee_token_not_allowlisted')).toBe('not_allowlisted');
    expect(payInRefusal('protocol.fee_token_oracle_stale')).toBe('oracle_stale');
    expect(payInRefusal('protocol.fee_token_oracle_unread')).toBe('oracle_unread');
    expect(payInRefusal('protocol.fee_relay_unset')).toBe('relay_unset');
    expect(payInRefusal('protocol.chain_unreachable')).toBe('unread');
    expect(payInRefusal(undefined)).toBe('unread');
  });

  it('offers every pool token and every relay token once, pool tokens first', () => {
    const usd = token('0x000000000000000000000000000000000000d011', 'TEST USD');
    const a = token('0x00000000000000000000000000000000000a11ce', 'TEST Token A');
    const eur = token('0x00000000000000000000000000000000000e0e00', 'TEST EUR');
    const usdAgain = { ...usd, address: usd.address.toUpperCase().replace('0X', '0x') };
    expect(payInTokens([a, usd], [usdAgain, eur]).map((t) => t.name)).toEqual(['TEST Token A', 'TEST USD', 'TEST EUR']);
    expect(NATIVE).toBe('native');
  });
});
