import { describe, expect, it } from 'vitest';
import { botName } from './bot-name';
import { roomCopy } from './copy';

describe('botName', () => {
  const t = (key: 'Spot grid') => roomCopy.t(key);

  it('names an algo bot by its kind and market, never a copy key', () => {
    expect(botName('twap', 'BTC/USDT', t)).toBe('TWAP BTC/USDT');
    expect(botName('vwap', 'ETH/USDT', t)).toBe('VWAP ETH/USDT');
    expect(botName('pov', 'BTC/USDC', t)).toBe('POV BTC/USDC');
  });

  it('names a grid in words', () => {
    expect(botName('grid', 'BTC/USDT', t)).toBe('Spot grid BTC/USDT');
  });

  it('reads a kind it does not know in capitals', () => {
    expect(botName('iceberg', 'BTC/USDT', t)).toBe('ICEBERG BTC/USDT');
  });
});
