/**
 * Solid surfaces: the switch that turns every glass and translucent surface
 * opaque and blur off (`data-surfaces="solid"` on the root, read by lit.css).
 *
 * Why an in-app switch: Safari never exposes Reduce Transparency to the web
 * (`prefers-reduced-transparency` is unsupported there, WebKit bug 175497), so
 * the iPhone users who most need it can't reach it from their settings. The
 * switch is "auto" by default and turns solid on its own whenever the system
 * asks for more contrast, forced colours or less transparency. A person can
 * turn it on; nobody can turn it off against their own system setting.
 *
 * The preference lives on this device. A failure to read or write storage
 * (private mode, blocked site data) leaves the switch on "auto", never broken.
 */

export type SurfacesSetting = 'auto' | 'solid';
export type SurfacesMode = 'glass' | 'solid';

export const SURFACES_ATTRIBUTE = 'data-surfaces';
export const SURFACES_STORAGE_KEY = 'intafaced.surfaces';

/** Any of these matching turns Solid surfaces on, whatever the setting. */
export const SOLID_SURFACES_QUERIES = [
  '(prefers-contrast: more)',
  '(forced-colors: active)',
  '(prefers-reduced-transparency: reduce)',
] as const;

/** What the root should carry, from the setting and the system's own asks. */
export function resolveSurfaces(setting: SurfacesSetting, systemAsks: boolean): SurfacesMode {
  return setting === 'solid' || systemAsks ? 'solid' : 'glass';
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageOrNull(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readSurfacesSetting(storage?: StorageLike | null): SurfacesSetting {
  try {
    return storageOrNull(storage)?.getItem(SURFACES_STORAGE_KEY) === 'solid' ? 'solid' : 'auto';
  } catch {
    return 'auto';
  }
}

/** Returns false when the device would not keep it; the setting still applies for this visit. */
export function writeSurfacesSetting(setting: SurfacesSetting, storage?: StorageLike | null): boolean {
  try {
    const target = storageOrNull(storage);
    if (!target) return false;
    if (setting === 'solid') target.setItem(SURFACES_STORAGE_KEY, 'solid');
    else target.removeItem(SURFACES_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

interface Environment {
  readonly matchMedia?: (query: string) => MediaQueryListLike;
}

/** True when the system asks for solid surfaces. A query the engine doesn't know counts as not matching. */
export function systemAsksForSolid(env: Environment = typeof window === 'undefined' ? {} : window): boolean {
  if (!env.matchMedia) return false;
  return SOLID_SURFACES_QUERIES.some((query) => {
    try {
      return env.matchMedia?.(query).matches === true;
    } catch {
      return false;
    }
  });
}

interface RootLike {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Put the mode on `root` now and again whenever a system setting changes.
 * Returns the function that stops listening and takes the attribute off, so
 * nothing is left painting solid once nobody manages it.
 */
export function applySurfaces(
  root: RootLike,
  setting: SurfacesSetting,
  env: Environment = typeof window === 'undefined' ? {} : window,
): () => void {
  const update = (): void => root.setAttribute(SURFACES_ATTRIBUTE, resolveSurfaces(setting, systemAsksForSolid(env)));
  update();
  if (!env.matchMedia) return () => root.removeAttribute(SURFACES_ATTRIBUTE);
  const lists = SOLID_SURFACES_QUERIES.flatMap((query) => {
    try {
      const list = env.matchMedia?.(query);
      return list ? [list] : [];
    } catch {
      return [];
    }
  });
  for (const list of lists) list.addEventListener?.('change', update);
  return () => {
    for (const list of lists) list.removeEventListener?.('change', update);
    root.removeAttribute(SURFACES_ATTRIBUTE);
  };
}
