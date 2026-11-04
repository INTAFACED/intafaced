import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { chargedIn, FEE_CHARGED_TOPIC, NATIVE, payInRefusal, payInTokens } from './fee-token';

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

  it('reads what the relay actually charged from its FeeCharged event, for this owner only', () => {
    expect(FEE_CHARGED_TOPIC).toBe(keccak256(toHex('FeeCharged(address,address,address,uint256,uint256,uint16,uint256)')));
    const relay = '0x9d4454b023096f34b160d6b654540c56a1f81688';
    const owner = '0x52908400098527886E0F7030069857D2E4169EE7';
    const word = (n: bigint) => n.toString(16).padStart(64, '0');
    const log = {
      address: relay,
      topics: [FEE_CHARGED_TOPIC, `0x${owner.slice(2).toLowerCase().padStart(64, '0')}`, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`],
      data: `0x${word(800n)}${word(400n)}${word(500n)}${word(1234n)}`,
    };
    expect(chargedIn([log], relay, owner)).toBe(1234n);
    expect(chargedIn([log], relay, '0x00000000000000000000000000000000000a11ce')).toBeNull();
    expect(chargedIn([{ ...log, address: '0x00000000000000000000000000000000000b0b00' }], relay, owner)).toBeNull();
  });
});
