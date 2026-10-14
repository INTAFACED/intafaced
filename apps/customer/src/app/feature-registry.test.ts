import { describe, expect, it } from 'vitest';
import {
  effectiveStatus,
  featureById,
  features,
  hiddenFeatureFor,
  isFeatureLive,
  isFeaturePreview,
  isHiddenPath,
  isPreviewEnabled,
  isPreviewPath,
  previewFeatureFor,
  tabHome,
} from './feature-registry';
import { previewProductIds, previewProducts } from '../preview/products';
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
    ])
      expect(isHiddenPath(path, false), path).toBe(true);
    for (const path of [
      '/home',
      '/money',
      '/money/activity',
      '/trade',
      '/trade/spot/BTC-USDT',
      '/trade/buy',
      '/trade/convert',
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
      expect(isHiddenPath(path, false), path).toBe(false);
  });
  it('hides simulated markets by their query string', () => {
    expect(hiddenFeatureFor('/trade', '?simulated=true', false)?.id).toBe('simulated-markets');
    expect(hiddenFeatureFor('/trade', '?simulated=false', false)).toBeUndefined();
    expect(hiddenFeatureFor('/trade', '', false)).toBeUndefined();
  });
  it('sends a hidden path to its tab home, and none of those homes is hidden', () => {
    expect(tabHome(featureById('deposit')!)).toBe('/money');
    expect(tabHome(featureById('futures')!)).toBe('/trade');
    expect(tabHome(featureById('p2p')!)).toBe('/pay');
    expect(tabHome(featureById('more-rooms')!)).toBe('/more');
    expect(tabHome(featureById('promotions-dividends')!)).toBe('/more');
    expect(tabHome(featureById('public-extras')!)).toBe('/');
    for (const feature of features) expect(isHiddenPath(tabHome(feature), false), feature.id).toBe(false);
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

describe('top-bar menus list only live features', () => {
  const titles = (door: string, mode: 'simple' | 'pro' = 'simple') =>
    tabSpecs(mode, true, false)
      .find((tab) => tab.door === door)!
      .items.map((item) => item.title);
  it('matches the spec rows', () => {
    expect(titles('Home')).toEqual([]);
    expect(titles('Money')).toEqual(['Portfolio', 'Activity']);
    // Buy and Convert are live with their M2 screens (B8, Opus money review PASS 2026-10-14).
    expect(titles('Trade')).toEqual(['Markets', 'Spot', 'Buy and sell', 'Convert']);
    expect(titles('Pay')).toEqual(['Send', 'Receive']);
    expect(titles('More')).toEqual(['Help', 'Settings']);
  });
  it('links no hidden path and uses only plain words', () => {
    const { t } = shellCopy.forLocale('en');
    for (const previewEnabled of [false, true])
      for (const tab of tabSpecs('simple', true, previewEnabled))
        for (const item of tab.items) {
          expect(isHiddenPath(item.href.split('?')[0] ?? '', previewEnabled), item.href).toBe(false);
          expect(`${t(item.title)} ${t(item.description)}`).not.toMatch(
            /unavailable|not connected|restricted|fixture|lifecycle|room|door|ledger|demo|fake|mock/i,
          );
        }
  });
  it('sends a signed-out visitor to the public Help centre, never to a page that needs a session', () => {
    const more = tabSpecs('simple', false, false).find((tab) => tab.door === 'More')!;
    expect(more.href).toBe('/help');
    expect(more.items.map((item) => item.href)).toEqual(['/help']);
    for (const path of ['/help']) expect(findRoom(path)?.area).toBe('public');
    const signedIn = tabSpecs('simple', true, false).find((tab) => tab.door === 'More')!;
    expect(signedIn.href).toBe('/more');
    expect(signedIn.items.map((item) => item.href)).toEqual(['/support', '/view']);
  });
  it('points the Trade tab at the markets list in Simple and the desk in Pro', () => {
    expect(tabSpecs('simple', true, false).find((tab) => tab.door === 'Trade')?.href).toBe('/trade');
    expect(tabSpecs('pro', true, false).find((tab) => tab.door === 'Trade')?.href).toBe('/trade/spot/BTC-USDT');
  });
});

describe('the preview state and its build flag', () => {
  it('is on for dev and the local test stack, off in a plain production build', () => {
    expect(isPreviewEnabled({ DEV: true })).toBe(true);
    expect(isPreviewEnabled({ VITE_LOCAL_TEST: '1' })).toBe(true);
    expect(isPreviewEnabled({ DEV: false })).toBe(false);
    expect(isPreviewEnabled({})).toBe(false);
    expect(isPreviewEnabled({ VITE_LOCAL_TEST: '0' })).toBe(false);
  });
  it('lets VITE_PREVIEW_PRODUCTS decide: 1 turns it on (staging), anything else turns it off', () => {
    expect(isPreviewEnabled({ DEV: false, VITE_PREVIEW_PRODUCTS: '1' })).toBe(true);
    expect(isPreviewEnabled({ DEV: true, VITE_PREVIEW_PRODUCTS: '0' })).toBe(false);
    expect(isPreviewEnabled({ DEV: true, VITE_PREVIEW_PRODUCTS: 'true' })).toBe(false);
    expect(isPreviewEnabled({ DEV: true, VITE_PREVIEW_PRODUCTS: '' })).toBe(true);
  });
  it('has a preview row, a room, a screen and a fixture for every product', () => {
    for (const id of previewProductIds) {
      const feature = featureById(id);
      expect(feature?.status, id).toBe('preview');
      expect(feature?.paths, id).toEqual([
        previewProducts[id].path,
        ...(previewProducts[id].legacyPath ? [previewProducts[id].legacyPath] : []),
      ]);
      expect(previewProducts[id].path, id).toBe(`/preview/${id}`);
      expect(findRoom(previewProducts[id].path)?.screen, id).toBe(`preview/${id}`);
      const legacy = previewProducts[id].legacyPath;
      if (legacy) expect(findRoom(legacy)?.alias, id).toBe(previewProducts[id].path);
    }
    expect(
      features
        .filter((feature) => feature.status === 'preview')
        .map((feature) => feature.id)
        .sort(),
    ).toEqual([...previewProductIds].sort());
  });
  it('treats a preview row as preview with the flag on and exactly like hidden with it off', () => {
    const futures = featureById('futures')!;
    expect(effectiveStatus(futures, true)).toBe('preview');
    expect(effectiveStatus(futures, false)).toBe('hidden');
    expect(effectiveStatus(featureById('buy-flow')!, false)).toBe('live');
    expect(effectiveStatus(featureById('bank')!, true)).toBe('hidden');
    for (const id of previewProductIds) {
      for (const path of [previewProducts[id].path, ...(previewProducts[id].legacyPath ? [previewProducts[id].legacyPath!] : [])]) {
        expect(isPreviewPath(path, true), path).toBe(true);
        expect(isHiddenPath(path, false), path).toBe(true);
      }
      const path = previewProducts[id].path;
      expect(isPreviewPath(path, true), id).toBe(true);
      expect(isHiddenPath(path, true), id).toBe(false);
      expect(previewFeatureFor(path, true)?.id, id).toBe(id);
      expect(isPreviewPath(path, false), id).toBe(false);
      expect(isHiddenPath(path, false), id).toBe(true);
      expect(hiddenFeatureFor(path, '', false)?.id, id).toBe(id);
      expect(isFeaturePreview(id, true), id).toBe(true);
      expect(isFeaturePreview(id, false), id).toBe(false);
      expect(isFeatureLive(id), id).toBe(false);
    }
    expect(isPreviewPath('/trade/spot/BTC-USDT', true)).toBe(false);
  });
  it('keeps the other paths of a split row hidden even with preview on', () => {
    for (const path of ['/uc/withdraw/address', '/uc/ad/create', '/otc', '/bank/spaces']) expect(isHiddenPath(path, true), path).toBe(true);
  });
  it('lists the preview rows in the top-bar menus with a chip flag only when the flag is on', () => {
    const rows = (previewEnabled: boolean) =>
      tabSpecs('pro', true, previewEnabled).flatMap((tab) => tab.items.filter((item) => item.preview).map((item) => item.id));
    expect(rows(false)).toEqual([]);
    expect([...rows(true)].sort()).toEqual([...previewProductIds].sort());
    const { t } = shellCopy.forLocale('en');
    for (const tab of tabSpecs('pro', true, true))
      for (const item of tab.items.filter((candidate) => candidate.preview)) {
        expect(item.href, item.id).toBe(previewProducts[item.id as keyof typeof previewProducts].path);
        expect(t(item.title), item.id).toBe(previewProducts[item.id as keyof typeof previewProducts].name);
        expect(t(item.description), item.id).toBe(previewProducts[item.id as keyof typeof previewProducts].line);
      }
  });
  it('shows preview rows only to a signed-in visitor where the room needs a session', () => {
    expect(tabSpecs('pro', false, true).flatMap((tab) => tab.items.map((item) => item.id))).not.toContain('ifc');
  });
});
