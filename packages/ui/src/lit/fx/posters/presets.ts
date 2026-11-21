/**
 * Every light object a screen shows, with the exact options its poster is rendered from, so the poster (shown first,
 * and for good on the `poster` tier) equals the live object's first frame. Add an entry, then run
 * `pnpm --filter @intafaced/ui fx:posters` and commit the image; `presets.test.ts` fails when an image is missing.
 *
 * Posters are wide (1200 CSS px) and the box shows them at its own height, centred, as the 3D camera does, so one
 * image fits any box up to that width.
 */
import type { FxKind, FxKinds } from '../index.js';

export interface FxPreset<K extends FxKind = FxKind> {
  kind: K;
  /** Poster size in CSS pixels; rendered at 2x. */
  width: number;
  height: number;
  options: FxKinds[K];
}

/** Lit glass blue, the default accent (Nino, 26 Oct 2026). Other accents are a switch and get posters with it. */
export const LIT_BLUE = { color: '#3f7dff', hot: '#c7dbff' } as const; // look-drift-allow: the baked poster accent, take four blue

function preset<K extends FxKind>(p: FxPreset<K>): FxPreset<K> {
  return p;
}

export const FX_PRESETS = {
  /** Home: "Where your money is", the sphere lit from below beside its legend; mood 0 until the screen passes today's change. */
  'sphere-home-blue': preset({ kind: 'sphere', width: 1200, height: 288, options: { ...LIT_BLUE, mood: 0, dist: 5.1, y: 0.02 } }),
} as const;

export type FxPresetName = keyof typeof FX_PRESETS;
