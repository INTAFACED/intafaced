import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ScreenId, ScreenProps } from './screen-types';

export type ScreenComponent = LazyExoticComponent<ComponentType<ScreenProps>>;

/**
 * Registry of redesigned screens (UI-SPEC 7.2, B2). Every id is a folder under `src/screens/`
 * whose `index.tsx` default-exports a component taking `ScreenProps`. Until a screen's builder
 * replaces its file, the stub there renders the old view inside `.legacy-room`, so every route
 * keeps working through the migration. Each stub file belongs to that screen's builder.
 */
const home = import.meta.glob<{ default: ComponentType<ScreenProps> }>('../screens/home/index.tsx');

export const screens: Record<ScreenId, ScreenComponent> = {
  // Home belongs to B4. It is looked up by path so this file builds before and after B4 merges;
  // until then the old Money view stands in.
  home: lazy(() => {
    const load = Object.values(home)[0];
    return load ? load() : import('./HomeFallback');
  }),
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
};
