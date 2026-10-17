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
  it('hides nothing: no row is hidden and every route-bearing row is live or blocked (founder order 2026-10-17)', () => {
    for (const feature of features) expect(['live', 'blocked'], feature.id).toContain(feature.status);
    for (const feature of features.filter((row) => row.paths.length > 0)) expect(feature.status === 'hidden', feature.id).toBe(false);
  });
  it('keeps the old dead ends and the live rooms reachable, never hidden', () => {
    for (const path of [
      '/uc/recharge',
      '/uc/withdraw',
      '/uc/withdraw/address',
      '/portfolio/BTC/repeat-buy',
      '/bank',
      '/bank/earn',
      '/trade/margin',
      '/trade/copy',
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
      '/home',
      '/money',
      '/money/activity',
      '/trade',
      '/trade/spot/BTC-USDT',
      '/trade/buy',
      '/trade/convert',
      '/trade/options',
      '/execution',
      '/otc',
      '/coin/BTC',
      '/portfolio/BTC',
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
  it('keeps the old dead ends marked blocked, so /dev/features still names the reason and the unlock', () => {
    for (const id of ['deposit', 'withdraw', 'repeat-buy', 'bank', 'margin-futures-options', 'p2p', 'business-pay', 'more-rooms'])
      expect(featureById(id)?.status, id).toBe('blocked');
    expect(featureById('bank')?.paths).toContain('/bank');
    expect(findRoom('/bank')?.alias, '/bank is its own page, not an alias of /money').toBeUndefined();
  });
  it('does not hide simulated markets by their query string either', () => {
    expect(featureById('simulated-markets')?.status).toBe('blocked');
    expect(hiddenFeatureFor('/trade', '?simulated=true')).toBeUndefined();
    expect(hiddenFeatureFor('/trade', '?simulated=false')).toBeUndefined();
    expect(hiddenFeatureFor('/trade', '')).toBeUndefined();
  });
  it('names the landing page of each tab, and none of those homes is hidden', () => {
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
  it('marks Passkeys live with a note on how WebAuthn is set up', () => {
    const passkeys = featureById('passkeys');
    expect(isFeatureLive('passkeys')).toBe(true);
    // A section of Security, not a route of its own: nothing to hide, nothing to redirect.
    expect(passkeys?.paths).toEqual([]);
    expect(passkeys?.checked).toMatch(/2026-10-14.*WEBAUTHN_ENABLED=true.*localhost/);
    expect(isHiddenPath('/uc/safe')).toBe(false);
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

describe('top-bar menus link rooms that open', () => {
  const titles = (door: string, mode: 'simple' | 'pro' = 'simple') =>
    tabSpecs(mode)
      .find((tab) => tab.door === door)!
      .items.map((item) => item.title);
  it('matches the spec rows', () => {
    expect(titles('Home')).toEqual([]);
    expect(titles('Money')).toEqual(['Portfolio', 'Activity']);
    // Buy and Convert are live with their M2 screens (B8, Opus money review PASS 2026-10-14).
    expect(titles('Trade')).toEqual(['Markets', 'Spot', 'Buy and sell', 'Convert']);
    expect(titles('Pay')).toEqual(['Send', 'Receive', 'Merchant']);
    expect(titles('More')).toEqual(['Academy', 'All rooms', 'Help', 'Settings']);
  });
  it('links the Merchant home from Pay and Academy from More, and uses only plain words', () => {
    const { t } = shellCopy.forLocale('en');
    expect(
      tabSpecs('simple')
        .find((tab) => tab.door === 'Pay')!
        .items.map((item) => item.href),
    ).toContain('/pay/merchant');
    for (const tab of tabSpecs('simple'))
      for (const item of tab.items) {
        expect(isHiddenPath(item.href.split('?')[0] ?? ''), item.href).toBe(false);
        // The "All rooms" row is named by the founder order (2026-10-17), so its title is the one place the word may appear.
        expect(`${t(item.title).replace('All rooms', '')} ${t(item.description)}`).not.toMatch(
          /unavailable|not connected|restricted|fixture|lifecycle|room|door|ledger/i,
        );
      }
  });
  it('sends a signed-out visitor to the public Help centre, never to a page that needs a session', () => {
    const more = tabSpecs('simple', false).find((tab) => tab.door === 'More')!;
    expect(more.href).toBe('/help');
    expect(more.items.map((item) => item.href)).toEqual(['/help']);
    for (const path of ['/help']) expect(findRoom(path)?.area).toBe('public');
    const signedIn = tabSpecs('simple', true).find((tab) => tab.door === 'More')!;
    expect(signedIn.href).toBe('/more');
    expect(signedIn.items.map((item) => item.href)).toEqual(['/academy', '/more', '/support', '/view']);
  });
  it('points the Trade tab at the markets list in Simple and the desk in Pro', () => {
    expect(tabSpecs('simple').find((tab) => tab.door === 'Trade')?.href).toBe('/trade');
    expect(tabSpecs('pro').find((tab) => tab.door === 'Trade')?.href).toBe('/trade/spot/BTC-USDT');
  });
});
