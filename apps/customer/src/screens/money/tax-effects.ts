import { ACTIVITY_KINDS, type ActivityKind } from './deps';

/** The tax effects the screen has words for. An effect the owner names that is not here shows as it was named. */
export const KNOWN_EFFECTS = ['income', 'disposal', 'neutral'] as const;
export type KnownEffect = (typeof KNOWN_EFFECTS)[number];

export interface EffectGroup {
  readonly effect: string;
  readonly kinds: readonly string[];
}

/**
 * The owner's map from a kind of activity to its tax effect, as groups: known effects first in a fixed order, then any
 * other effect by name. A kind the map does not name is listed apart as not set, never put in a group by guess.
 */
export function groupKindsByEffect(effects: Readonly<Record<string, string>>): { groups: EffectGroup[]; unset: ActivityKind[] } {
  const byEffect = new Map<string, string[]>();
  for (const [kind, effect] of Object.entries(effects)) {
    const words = effect.trim();
    if (!words) continue;
    byEffect.set(words, [...(byEffect.get(words) ?? []), kind]);
  }
  const known: string[] = [...KNOWN_EFFECTS];
  const order = [...known.filter((e) => byEffect.has(e)), ...[...byEffect.keys()].filter((e) => !known.includes(e)).sort()];
  return {
    groups: order.map((effect) => ({ effect, kinds: byEffect.get(effect) ?? [] })),
    unset: ACTIVITY_KINDS.filter((kind) => !effects[kind]?.trim()),
  };
}
