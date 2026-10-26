import { useCallback, useEffect, useState } from 'react';
import {
  applySurfaces,
  readSurfacesSetting,
  resolveSurfaces,
  systemAsksForSolid,
  writeSurfacesSetting,
  type SurfacesMode,
  type SurfacesSetting,
} from './surfaces.js';

export interface SolidSurfaces {
  /** What the person chose on this device. */
  readonly setting: SurfacesSetting;
  /** What the screen shows: solid when chosen or when the system asks for it. */
  readonly mode: SurfacesMode;
  /** True when a system setting holds it solid, so the switch can say why it can't turn off. */
  readonly heldBySystem: boolean;
  readonly setSetting: (setting: SurfacesSetting) => void;
}

/**
 * The Solid surfaces switch for a settings row: keeps `data-surfaces` on the
 * root in step with the setting and the system, and remembers the choice on
 * this device. Mount it once, high in the tree, where the look is on.
 */
export function useSolidSurfaces(): SolidSurfaces {
  const [setting, setState] = useState<SurfacesSetting>(() => readSurfacesSetting());
  const [heldBySystem, setHeld] = useState(() => systemAsksForSolid());

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    return applySurfaces(
      {
        setAttribute: (name, value) => {
          root.setAttribute(name, value);
          setHeld(systemAsksForSolid());
        },
      },
      setting,
    );
  }, [setting]);

  const setSetting = useCallback((next: SurfacesSetting) => {
    writeSurfacesSetting(next);
    setState(next);
  }, []);

  return { setting, mode: resolveSurfaces(setting, heldBySystem), heldBySystem, setSetting };
}
