import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  SURFACES_STORAGE_KEY,
  SOLID_SURFACES_QUERIES,
  applySurfaces,
  readSurfacesSetting,
  resolveSurfaces,
  systemAsksForSolid,
  writeSurfacesSetting,
  type SurfacesMode,
  type SurfacesSetting,
} from './surfaces.js';

/**
 * One shared state for the whole page: the setting row and the root read the same value, and a change
 * in another tab (the `storage` event) or in the system reaches both.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let setting: SurfacesSetting | null = null;
let held = false;
let detach: (() => void) | null = null;

function snapshot(): string {
  return `${setting ?? 'auto'}|${held ? 'held' : 'free'}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function attach(): void {
  if (detach || typeof window === 'undefined') return;
  setting = readSurfacesSetting();
  held = systemAsksForSolid();
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== SURFACES_STORAGE_KEY) return;
    setting = readSurfacesSetting();
    emit();
  };
  const onSystem = (): void => {
    held = systemAsksForSolid();
    emit();
  };
  const lists = SOLID_SURFACES_QUERIES.flatMap((query) => {
    try {
      return [window.matchMedia(query)];
    } catch {
      return [];
    }
  });
  window.addEventListener('storage', onStorage);
  for (const list of lists) list.addEventListener('change', onSystem);
  detach = () => {
    window.removeEventListener('storage', onStorage);
    for (const list of lists) list.removeEventListener('change', onSystem);
    detach = null;
  };
}

function subscribe(listener: Listener): () => void {
  attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach?.();
  };
}

function setShared(next: SurfacesSetting): void {
  writeSurfacesSetting(next);
  setting = next;
  emit();
}

export interface SolidSurfaces {
  /** What the person chose on this device. */
  readonly setting: SurfacesSetting;
  /** What the screen shows: solid when chosen or when the system asks for it. */
  readonly mode: SurfacesMode;
  /** True when a system setting holds it solid, so the switch can say why it can't turn off. */
  readonly heldBySystem: boolean;
  readonly setSetting: (setting: SurfacesSetting) => void;
}

/** The Solid surfaces switch for a settings row. Any number of rows share one state. */
export function useSolidSurfaces(): SolidSurfaces {
  const state = useSyncExternalStore(subscribe, snapshot, () => 'auto|free');
  const [current, hold] = state.split('|') as [SurfacesSetting, 'held' | 'free'];
  const heldBySystem = hold === 'held';
  const setSetting = useCallback((next: SurfacesSetting) => setShared(next), []);
  return { setting: current, mode: resolveSurfaces(current, heldBySystem), heldBySystem, setSetting };
}

/**
 * Keeps `data-surfaces` on the document root in step with the shared setting and the system. Mount it
 * once, where the look is switched on; unmounting takes the attribute off.
 */
export function useSolidSurfacesRoot(): void {
  const { setting: current } = useSolidSurfaces();
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    return applySurfaces(document.documentElement, current);
  }, [current]);
}
