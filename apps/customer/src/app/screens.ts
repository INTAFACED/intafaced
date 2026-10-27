import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ScreenId, ScreenProps } from './screen-types';

export type ScreenComponent = LazyExoticComponent<ComponentType<ScreenProps>>;

/**
 * Registry of redesigned screens (UI-SPEC 7.2, B2). Every id is a folder under `src/screens/`
 * whose `index.tsx` default-exports a component taking `ScreenProps`. Until a screen's builder
 * replaces its file, the stub there renders the old view inside `.legacy-room`, so every route
 * keeps working through the migration. Each stub file belongs to that screen's builder.
 */
type Loader = () => Promise<{ default: ComponentType<ScreenProps> }>;

const loaders: Record<ScreenId, Loader> = {
  home: () => import('../screens/home'),
  money: () => import('../screens/money'),
  coin: () => import('../screens/coin'),
  'trade/markets': () => import('../screens/trade/markets'),
  'trade/desk': () => import('../screens/trade/desk'),
  'trade/buy': () => import('../screens/trade/buy'),
  'trade/convert': () => import('../screens/trade/convert'),
  'trade/options': () => import('../screens/trade/options'),
  'trade/execution': () => import('../screens/trade/execution'),
  'trade/otc': () => import('../screens/trade/otc'),
  'trade/futures': () => import('../screens/trade/futures'),
  'trade/margin': () => import('../screens/trade/margin'),
  charts: () => import('../screens/charts'),
  pay: () => import('../screens/pay'),
  more: () => import('../screens/more'),
  notifications: () => import('../screens/notifications'),
  account: () => import('../screens/account'),
};

export const screens = Object.fromEntries(Object.entries(loaders).map(([id, load]) => [id, lazy(load)])) as Record<
  ScreenId,
  ScreenComponent
>;

/**
 * Starts downloading a screen's code before it can render (a signed-in room waits for the boot refresh first), so
 * the two happen side by side. `lazy` reuses the same module when the screen renders.
 */
export function preloadScreen(id: ScreenId): void {
  void loaders[id]().catch(() => undefined);
}
