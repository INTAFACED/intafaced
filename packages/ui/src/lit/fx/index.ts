/**
 * The light objects of the Lit glass look (sphere, field, logo, coin): the public, three.js-free entry. It decides the
 * device tier and loads the 3D engine lazily, after first paint, only when the tier asks for it.
 *
 *   const stop = await mountFx(box, canvas, 'sphere', { color, hot, shares }, { onReady, onFail });
 *
 * Budgets and rules: README.md beside this file.
 */
import { deviceTier, isTier, type FxTier } from './tier.js';
import type { SphereOptions } from './objects/sphere.js';
import type { FieldOptions } from './objects/field.js';
import type { LogoOptions } from './objects/logo.js';
import type { CoinOptions } from './objects/coin.js';

export { chooseTier, deviceTier, isSoftwareRenderer, type FxTier, type DeviceSignals } from './tier.js';
export { seededRandom, FX_SEED } from './random.js';
export type { SphereOptions, FieldOptions, LogoOptions, CoinOptions };

export interface FxKinds {
  sphere: SphereOptions;
  field: FieldOptions;
  logo: LogoOptions;
  coin: CoinOptions;
}
export type FxKind = keyof FxKinds;

export interface FxMountOptions {
  /** Draw one frame at t = 0 and stop. Also on whenever the root element has `data-fx-still`. */
  still?: boolean;
  seed?: number;
  onReady?(): void;
  onFail?(reason: string): void;
}

type Engine = typeof import('./engine.js');
let engine: Promise<Engine> | null = null;

/** Starts loading the 3D chunk without mounting anything (call after first paint, when the tier isn't `poster`). */
export function preloadFx(): Promise<Engine> {
  engine ??= import('./engine.js');
  return engine;
}

function forcedTier(): boolean {
  try {
    return isTier(new URLSearchParams(location.search).get('fx')) || isTier(document.documentElement.dataset.fxTier);
  } catch {
    return false;
  }
}

function stillPage(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-fx-still');
}

/**
 * Mounts one light object into `canvas`, sized to `box`. Resolves to the unmount function. With the `poster` tier,
 * or when WebGL fails, nothing loads: `onFail` is called and the caller keeps showing the poster.
 */
export async function mountFx<K extends FxKind>(
  box: HTMLElement,
  canvas: HTMLCanvasElement,
  kind: K,
  options: FxKinds[K],
  mount: FxMountOptions = {},
): Promise<() => void> {
  const tier: FxTier = deviceTier();
  const fail = (reason: string) => mount.onFail?.(reason);
  if (tier === 'poster') {
    fail('tier-poster');
    return () => undefined;
  }
  try {
    const [e, objects] = await Promise.all([preloadFx(), import('./objects/index.js')]);
    const factory = objects.factories[kind] as (ctx: import('./engine.js').FxContext, o: FxKinds[K]) => import('./engine.js').FxScene;
    return await e.mountView(box, canvas, (ctx) => factory(ctx, options), {
      tier,
      forced: forcedTier(),
      still: mount.still === true || stillPage(),
      seed: mount.seed,
      onReady: () => mount.onReady?.(),
      onFail: fail,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : 'webgl-failed');
    return () => undefined;
  }
}

/** Re-colours every mounted object (the accent switch). No-op before the engine has loaded. */
export async function setFxAccent(accent: string, hot?: string): Promise<void> {
  if (!engine) return;
  (await engine).setAccent(accent, hot);
}

export { LitFx, type LitFxProps } from './LitFx.js';
export { sharesFromPercents, sphereCallouts } from './sphere-layout.js';
export { FX_PRESETS, LIT_BLUE, type FxPreset, type FxPresetName } from './posters/presets.js';
