import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTING, chartsHref, intervalFromSearch, isWorkbenchSetting, settingKey, workbenchId } from './workbench';

describe('workbench settings', () => {
  it('accepts only an offered interval and style, so a stale stored value falls back to the default', () => {
    expect(isWorkbenchSetting({ interval: '1h', mode: 'line' })).toBe(true);
    expect(isWorkbenchSetting({ interval: '7m', mode: 'line' })).toBe(false);
    expect(isWorkbenchSetting({ interval: '1h', mode: 'renko' })).toBe(false);
    expect(isWorkbenchSetting(null)).toBe(false);
    expect(DEFAULT_SETTING).toEqual({ interval: '15m', mode: 'candles', scheme: 'standard' });
  });

  it('names the workbench from ?w= and gives everyone their own default one', () => {
    expect(workbenchId('')).toBe('main');
    expect(workbenchId('?w=desk-2')).toBe('desk-2');
    expect(workbenchId('?w=bad id!')).toBe('main');
    expect(settingKey('u1', 'main')).not.toBe(settingKey('u2', 'main'));
    expect(settingKey(null, 'main')).toBe('charts-workbench:guest:main');
  });

  it('reads an interval from the address and ignores one that is not offered', () => {
    expect(intervalFromSearch('?interval=4h')).toBe('4h');
    expect(intervalFromSearch('?interval=9m')).toBeUndefined();
    expect(intervalFromSearch('')).toBeUndefined();
  });

  it('builds the address of a pair on a workbench', () => {
    expect(chartsHref('BTC-USDT')).toBe('/charts/BTC-USDT');
    expect(chartsHref('BTC-USDT', { interval: '1h', workbench: 'desk-2' })).toBe('/charts/BTC-USDT?w=desk-2&interval=1h');
    expect(chartsHref('BTC-USDT', { workbench: 'main' })).toBe('/charts/BTC-USDT');
  });
});
