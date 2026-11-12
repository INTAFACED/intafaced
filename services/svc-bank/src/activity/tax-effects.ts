import { isExplicitDevOrTest } from '@intafaced/config';
import type { ActivityKind } from './activity-kind.js';
import { TAX_EFFECT_BY_KIND } from './activity-service.js';

/**
 * WHICH TAX EFFECT EACH KIND OF LINE HAS (J-portfolio-03 #7).
 *
 * The real map is a tax call only the owner and counsel can make (`TAX_EFFECT_BY_KIND`, blank): while it is blank,
 * `activity.taxEffects` refuses `portfolio.tax_effect_map_unset` by name and no line is ever given an effect.
 *
 * `BANK_TAX_EFFECTS=test` puts a TEST map in its place on a dev or test stack only, so the grouping can be shown working.
 * It is made up for test stacks: not the owner's or counsel's call, and the answer says TEST so the screen says it too. The
 * service refuses to start with it when `APP_ENV` is not exactly `dev` or `test`, or under `NODE_ENV=production`. Once
 * the owner's map is set, it is the map, with or without the switch.
 */

export const TAX_EFFECTS_SETTINGS = ['off', 'test'] as const;
export type TaxEffectsSetting = (typeof TAX_EFFECTS_SETTINGS)[number];

export type TaxEffect = 'income' | 'disposal' | 'neutral';

/** TEST: made up for test stacks. Not a tax treatment anyone decided. Every kind has one, so nothing reads "not set". */
export const TEST_TAX_EFFECT_BY_KIND: Readonly<Record<ActivityKind, TaxEffect>> = Object.freeze({
  deposit: 'neutral',
  welcome_funds: 'income',
  transfer_in: 'neutral',
  transfer_out: 'neutral',
  trade: 'disposal',
  convert: 'disposal',
  fee: 'neutral',
  payment: 'disposal',
  withdrawal: 'neutral',
  space_move: 'neutral',
  order_hold: 'neutral',
  order_release: 'neutral',
  earn: 'income',
  staking: 'neutral',
  reward: 'income',
  other: 'neutral',
});

export interface TaxEffectMap {
  readonly effects: Readonly<Record<string, string>>;
  /** `TEST` when the map is the test stacks' stand-in, else null (the owner's own map). */
  readonly label: 'TEST' | null;
}

export class TestTaxEffectsRefusedError extends Error {
  readonly code = 'bank.test_tax_effects_outside_dev_test' as const;
  constructor() {
    super('BANK_TAX_EFFECTS=test is a TEST tax-effect map made up for test stacks; it runs only with APP_ENV exactly dev or test.');
    this.name = 'TestTaxEffectsRefusedError';
  }
}

/**
 * The map `activity.taxEffects` answers with: the owner's once it is set; else the TEST one when chosen on a dev or test
 * stack; else null, which refuses by name. Chosen anywhere else, it throws, so the service does not start.
 */
export function taxEffectsFor(
  setting: TaxEffectsSetting,
  env: { readonly APP_ENV?: string | undefined; readonly NODE_ENV?: string | undefined },
  owner: Readonly<Partial<Record<ActivityKind, string>>> = TAX_EFFECT_BY_KIND,
): TaxEffectMap | null {
  if (setting === 'test' && (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production')) throw new TestTaxEffectsRefusedError();
  if (Object.keys(owner).length > 0) return { effects: { ...owner } as Record<string, string>, label: null };
  if (setting === 'test') return { effects: { ...TEST_TAX_EFFECT_BY_KIND }, label: 'TEST' };
  return null;
}
