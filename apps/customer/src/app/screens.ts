import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ScreenId, ScreenProps } from './screen-types';

export type ScreenComponent = LazyExoticComponent<ComponentType<ScreenProps>>;

/**
 * Registry of redesigned screens (UI-SPEC 7.2, B2). Every id is a folder under `src/screens/`
 * whose `index.tsx` default-exports a component taking `ScreenProps`. Until a screen's builder
 * replaces its file, the stub there renders the old view inside `.legacy-room`, so every route
 * keeps working through the migration. Each stub file belongs to that screen's builder.
 */
export const screens: Record<ScreenId, ScreenComponent> = {
  home: lazy(() => import('../screens/home')),
  money: lazy(() => import('../screens/money')),
  coin: lazy(() => import('../screens/coin')),
  'trade/markets': lazy(() => import('../screens/trade/markets')),
  'trade/desk': lazy(() => import('../screens/trade/desk')),
  'trade/buy': lazy(() => import('../screens/trade/buy')),
  'trade/convert': lazy(() => import('../screens/trade/convert')),
  pay: lazy(() => import('../screens/pay')),
  more: lazy(() => import('../screens/more')),
  notifications: lazy(() => import('../screens/notifications')),
  account: lazy(() => import('../screens/account')),
  'preview/futures': lazy(() => import('../screens/preview/futures')),
  'preview/options': lazy(() => import('../screens/preview/options')),
  'preview/margin': lazy(() => import('../screens/preview/margin')),
  'preview/earn': lazy(() => import('../screens/preview/earn')),
  'preview/loans': lazy(() => import('../screens/preview/loans')),
  'preview/bots': lazy(() => import('../screens/preview/bots')),
  'preview/agents': lazy(() => import('../screens/preview/agents')),
  'preview/copy': lazy(() => import('../screens/preview/copy')),
  'preview/p2p': lazy(() => import('../screens/preview/p2p')),
  'preview/card': lazy(() => import('../screens/preview/card')),
  'preview/ifc': lazy(() => import('../screens/preview/ifc')),
  'preview/deposit': lazy(() => import('../screens/preview/deposit')),
  'preview/withdraw': lazy(() => import('../screens/preview/withdraw')),
};
