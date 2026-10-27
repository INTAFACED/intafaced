import { useEffect } from 'react';
import {
  SURFACES_ATTRIBUTE,
  readSurfacesSetting,
  resolveSurfaces,
  systemAsksForSolid,
  trackObscuringBars,
  useSolidSurfacesRoot,
} from '@intafaced/ui/a11y';

/** Puts `data-surfaces` on the root at once, from the saved setting and the system, so the first paint is right. */
export function applyLookSurfaces(root: HTMLElement = document.documentElement): void {
  root.setAttribute(SURFACES_ATTRIBUTE, resolveSurfaces(readSurfacesSetting(), systemAsksForSolid()));
}

/**
 * The access hooks of the Lit glass look (`@intafaced/ui/a11y`, README there), mounted once beside the app where
 * `data-look` is set, and only when the look is on: the Solid surfaces switch keeps `data-surfaces` on the root, and
 * the fixed bars (`data-obscures` on the top bar and the phone dock) are measured into the scroll padding that keeps
 * a focused control clear of them. Unmounting takes both off the root again. Draws nothing.
 */
export function LitLookRoot() {
  useSolidSurfacesRoot();
  useEffect(() => trackObscuringBars(), []);
  return null;
}
