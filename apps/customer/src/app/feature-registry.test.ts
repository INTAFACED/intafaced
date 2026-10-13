import { describe, expect, it } from 'vitest';
import { featureById, features, hiddenFeatureFor, isFeatureLive, isHiddenPath, tabHome } from './feature-registry';
import { findRoom } from './navigation';
import { matchPath } from './path-match';
import { tabSpecs } from './menus';
import { shellCopy } from './shell-copy';

describe('feature registry (UI-SPEC 3.4)', () => {
  it('has unique ids and a reason and unlock for every row', () => {
    expect(new Set(features.map((feature) => feature.id)).size).toBe(features.length);
    for (const feature of features) {
      expect(feature.reason, feature.id).not.toBe('');
      expect(feature.unlock, feature.id).not.toBe('');
    }
  });
  it('lists only real routes: every concrete registry path is a room', () => {
    for (const feature of features)
      for (const path of feature.paths) {
        const sample = path.replace(/:[A-Za-z]+/g, 'x').replace(/\/\*$/, '');
        expect(findRoom(sample), `${feature.id}: ${path}`).toBeDefined();
      }
  });
  it('hides the dead ends and keeps live ones reachable', () => {
    for (const path of [
      '/uc/recharge',
      '/uc/withdraw',
      '/uc/withdraw/address',
      '/portfolio/BTC/repeat-buy',
      '/bank/earn',
      '/trade/margin',
      '/otc',
      '/otc/tradeInfo',
      '/pay/request',
      '/p2p',
      '/uc/ad/create',
      '/pay/merchant',
      '/identbusiness',
      '/academy/intro',
      '/campaigns',
      '/uc/promotion',
      '/notice/42',
      '/partner',
      '/trade/buy',
      '/trade/convert',
    ])
      expect(isHiddenPath(path), path).toBe(true);
    for (const path of [
      '/home',
      '/money',
      '/money/activity',
      '/coin/BTC',
      '/trade',
      '/trade/spot/BTC-USDT',
      '/pay',
      '/pay/send',
      '/pay/receive',
      '/more',
      '/help',
      '/support',
      '/notifications',
      '/uc/account',
      '/uc/safe',
      '/verification',
      '/view',
      '/login',
      '/',
      '/pay/checkout',
    ])
      expect(isHiddenPath(path), path).toBe(false);
  });
  it('hides simulated markets by their query string', () => {
    expect(hiddenFeatureFor('/trade', '?simulated=true')?.id).toBe('simulated-markets');
    expect(hiddenFeatureFor('/trade', '?simulated=false')).toBeUndefined();
    expect(hiddenFeatureFor('/trade', '')).toBeUndefined();
  });
  it('sends a hidden path to its tab home, and none of those homes is hidden', () => {
    expect(tabHome(featureById('deposit')!)).toBe('/money');
    expect(tabHome(featureById('margin-futures-options')!)).toBe('/trade');
    expect(tabHome(featureById('p2p')!)).toBe('/pay');
    expect(tabHome(featureById('more-rooms')!)).toBe('/more');
    expect(tabHome(featureById('promotions-dividends')!)).toBe('/more');
    expect(tabHome(featureById('public-extras')!)).toBe('/');
    for (const feature of features) expect(isHiddenPath(tabHome(feature)), feature.id).toBe(false);
  });
  it('records the live re-check, with evidence, for Help and Notifications', () => {
    for (const id of ['help-support', 'notifications']) {
      expect(isFeatureLive(id), id).toBe(true);
      expect(featureById(id)?.checked, id).toMatch(/2026-10-13/);
    }
  });
  it('shows the Pro switch from M2', () => {
    expect(isFeatureLive('pro-mode-switch')).toBe(true);
  });
});

describe('path matching', () => {
  it('captures params and rejects a different shape', () => {
    expect(matchPath('/coin/:asset', '/coin/BTC')).toEqual({ asset: 'BTC' });
    expect(matchPath('/coin/:asset', '/coin')).toBeUndefined();
    expect(matchPath('/coin/:asset', '/coin/BTC/x')).toBeUndefined();
    expect(matchPath('/otc/*', '/otc/trade/1/2')).toEqual({});
    expect(matchPath('/a', '/b')).toBeUndefined();
  });
});

describe('top-bar menus list only live features', () => {
  const titles = (door: string, mode: 'simple' | 'pro' = 'simple') =>
    tabSpecs(mode)
      .find((tab) => tab.door === door)!
      .items.map((item) => item.title);
  it('matches the spec rows', () => {
    expect(titles('Home')).toEqual([]);
    expect(titles('Money')).toEqual(['Portfolio', 'Activity']);
    // Buy and Convert come back with their M2 screens (B8); until then their old screens are hidden.
    expect(titles('Trade')).toEqual(['Markets', 'Spot']);
    expect(titles('Pay')).toEqual(['Send', 'Receive']);
    expect(titles('More')).toEqual(['Help', 'Settings']);
  });
  it('links no hidden path and uses only plain words', () => {
    const { t } = shellCopy.forLocale('en');
    for (const tab of tabSpecs('simple'))
      for (const item of tab.items) {
        expect(isHiddenPath(item.href.split('?')[0] ?? ''), item.href).toBe(false);
        expect(`${t(item.title)} ${t(item.description)}`).not.toMatch(
          /unavailable|not connected|restricted|fixture|lifecycle|room|door|ledger/i,
        );
      }
  });
  it('points the Trade tab at the markets list in Simple and the desk in Pro', () => {
    expect(tabSpecs('simple').find((tab) => tab.door === 'Trade')?.href).toBe('/trade');
    expect(tabSpecs('pro').find((tab) => tab.door === 'Trade')?.href).toBe('/trade/spot/BTC-USDT');
  });
});
