import {
  EARNING_TRIGGERS,
  POINTS_CATALOGUE_ITEMS,
  POINTS_EXPIRY_MODES,
  POINTS_LIFECYCLE,
  POINTS_OWNER_QUESTION,
  type EarningEvaluationResult,
  type EarningRule,
  type EarningTrigger,
  type PointsProgramme,
} from '@intafaced/contracts/campaigns-catalogue';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { CampaignsError } from './codes.js';
import { evaluateFormula, parseFormula } from './formula.js';

/**
 * The points programme (CM-rewards-hub-04, J-campaigns-15). Whether INTAFACED runs a points programme whose points have
 * value or convert to cash is the owner's question, still open. Until it is answered nothing here stores a point: the
 * programme reads as its full layout with every number blank, and every press that would earn, spend, expire, release,
 * redeem or convert points refuses `owner.decision` naming the question, before anything is read or written.
 */

/** The programme as every customer reads it while the owner question is open: the layout, no number. */
export function pointsProgramme(): PointsProgramme {
  return {
    blocker: { code: 'owner.decision', question: POINTS_OWNER_QUESTION },
    lifecycle: { stages: [...POINTS_LIFECYCLE], current: null },
    wallet: { available: null, pending: null, expiring: null },
    members: { count: null },
    expiry: { current: null, modes: POINTS_EXPIRY_MODES.map((mode) => ({ mode, horizonSeconds: null })) },
    pending: [],
    catalogue: POINTS_CATALOGUE_ITEMS.map((id) => ({ id, pricePoints: null, stock: null, perPersonLimit: null })),
    conversion: { rate: null, asset: null, minimumPoints: null },
  };
}

/** Refuses a points action by the owner question. Nothing is read or stored first. */
export function refusePoints(action: 'convert' | 'redeem'): never {
  throw new CampaignsError(
    'owner.decision',
    `${action === 'convert' ? 'Converting points' : 'Redeeming a catalogue reward'} waits for an owner decision: ${POINTS_OWNER_QUESTION}`,
  );
}

const DECIMAL = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;

/**
 * Each earning rule's answer to one TEST event (CM-rewards-hub-05 preview and test), in the order the rules are checked,
 * writing nothing. An incentive rule says what it would give in the reward asset; a points rule refuses `owner.decision`
 * for itself alone, so the other rules' answers stand. A trigger outside the catalogue refuses
 * `campaigns.trigger_unknown`, a name the trigger does not have `campaigns.formula_invalid`.
 */
export function evaluateEarning(
  rules: readonly EarningRule[],
  rewardAsset: string | null,
  trigger: string,
  typed: Readonly<Record<string, string>>,
): EarningEvaluationResult[] {
  const known = EARNING_TRIGGERS[trigger as EarningTrigger];
  if (!known) throw new CampaignsError('campaigns.trigger_unknown', `"${trigger}" is not a trigger in the catalogue`);
  const names: readonly string[] = known.names;
  const values: Record<string, bigint> = {};
  for (const name of names) values[name] = 0n;
  for (const [name, raw] of Object.entries(typed)) {
    if (!names.includes(name)) {
      throw new CampaignsError('campaigns.formula_invalid', `"${name}" is not a value of ${trigger}; it has ${names.join(', ')}`);
    }
    if (!DECIMAL.test(raw)) throw new CampaignsError('campaigns.formula_invalid', `${name} must be a decimal number`);
    values[name] = parseAmount(raw);
  }
  return rules.map((rule): EarningEvaluationResult => {
    const effect = rule.effect ?? 'incentive';
    if (rule.trigger !== trigger) return { outcome: 'nothing', rule: rule.name, effect, reason: 'other_trigger' };
    if (effect === 'points') {
      return { outcome: 'refused', rule: rule.name, effect: 'points', code: 'owner.decision', question: POINTS_OWNER_QUESTION };
    }
    if (rule.minAmount !== null && values.amount! < parseAmount(rule.minAmount)) {
      return { outcome: 'nothing', rule: rule.name, effect, reason: 'below_condition' };
    }
    const amount = evaluateFormula(parseFormula(rule.formula, names), values);
    if (amount <= 0n) return { outcome: 'nothing', rule: rule.name, effect, reason: 'zero' };
    return { outcome: 'gives', rule: rule.name, effect: 'incentive', amount: formatAmount(amount), asset: rewardAsset };
  });
}
