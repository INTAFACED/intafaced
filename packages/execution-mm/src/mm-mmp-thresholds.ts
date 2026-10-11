/**
 * execution.market-making MMP thresholds — refuse-closed when unset (PX-S08/PX-S10).
 *
 * Owner publishes filled quantity/delta/vega maxima, max open quotes, and
 * observation window. This module never invents DEFAULT_THRESHOLDS.
 * Unset / incomplete values disable mass quote, freeze, and reset.
 */
import { type Amount, parseAmount } from '@intafaced/ledger-client';

export const EXECUTION_MM_MMP_THRESHOLDS_ENV = 'EXECUTION_MM_MMP_THRESHOLDS' as const;

export type MmMmpThresholds = Readonly<{
  maxFilledQuantity: Amount;
  maxFilledDelta: number;
  maxFilledVega: number;
  maxOpenQuotes: number;
  observationWindowMs: number;
}>;

export type MmMmpThresholdsRefuseReason = 'mmp_thresholds_unset' | 'mmp_thresholds_invalid_json' | 'mmp_thresholds_incomplete';

export type MmMmpThresholdsGate =
  | { readonly configured: true; readonly thresholds: MmMmpThresholds }
  | { readonly configured: false; readonly reason: MmMmpThresholdsRefuseReason; readonly detail: string };

export type MmMmpAction = 'mass_quote' | 'freeze' | 'reset';

export type MmMmpActionRefusal = {
  readonly ok: false;
  readonly action: MmMmpAction;
  readonly reason: MmMmpThresholdsRefuseReason | 'mmp_observation_incomplete' | 'mmp_triggered';
  readonly detail: string;
};

export type MmMmpActionAccepted = {
  readonly ok: true;
  readonly action: MmMmpAction;
  readonly thresholds: MmMmpThresholds;
};

export type MmMmpActionResult = MmMmpActionAccepted | MmMmpActionRefusal;

export type MmMmpObservation = Readonly<{
  filledQuantity: Amount;
  filledDelta: number | null;
  filledVega: number | null;
  openQuotes: number;
}>;

export type MmMmpTriggerReason = 'filled_quantity' | 'filled_delta' | 'filled_vega' | 'open_quotes';

export type MmMmpTriggerClear = { readonly triggered: false };
export type MmMmpTriggerTripped = {
  readonly triggered: true;
  readonly reasons: readonly MmMmpTriggerReason[];
  readonly detail: string;
};
export type MmMmpTriggerEvaluation = MmMmpTriggerClear | MmMmpTriggerTripped;

function parseNonNegativeInt(
  obj: Record<string, unknown>,
  key: string,
  label: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly detail: string } {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, detail: `${label} must be a non-negative integer` };
  }
  return { ok: true, value };
}

function parseOwnerQuantity(
  obj: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: Amount } | { readonly ok: false; readonly detail: string } {
  const raw = obj[key];
  if (typeof raw !== 'string') {
    return { ok: false, detail: `${key} must be a decimal amount string` };
  }
  try {
    const value = parseAmount(raw);
    if (value < 0n) return { ok: false, detail: `${key} must be non-negative` };
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${key} is not a ledger amount: ${message}` };
  }
}

/** Parse owner MMP thresholds from env. Blank → refuse with mmp_thresholds_unset. */
export function mmMmpThresholdsGate(env: NodeJS.ProcessEnv = process.env): MmMmpThresholdsGate {
  const raw = env[EXECUTION_MM_MMP_THRESHOLDS_ENV]?.trim() ?? '';
  if (!raw) {
    return {
      configured: false,
      reason: 'mmp_thresholds_unset',
      detail: `${EXECUTION_MM_MMP_THRESHOLDS_ENV} is unset`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      configured: false,
      reason: 'mmp_thresholds_invalid_json',
      detail: 'MMP thresholds are not valid JSON',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      configured: false,
      reason: 'mmp_thresholds_invalid_json',
      detail: 'MMP thresholds must be a JSON object',
    };
  }

  const obj = parsed as Record<string, unknown>;
  const quantity = parseOwnerQuantity(obj, 'maxFilledQuantity');
  if (!quantity.ok) return { configured: false, reason: 'mmp_thresholds_incomplete', detail: quantity.detail };
  const delta = parseNonNegativeInt(obj, 'maxFilledDelta', 'maxFilledDelta');
  if (!delta.ok) return { configured: false, reason: 'mmp_thresholds_incomplete', detail: delta.detail };
  const vega = parseNonNegativeInt(obj, 'maxFilledVega', 'maxFilledVega');
  if (!vega.ok) return { configured: false, reason: 'mmp_thresholds_incomplete', detail: vega.detail };
  const openQuotes = parseNonNegativeInt(obj, 'maxOpenQuotes', 'maxOpenQuotes');
  if (!openQuotes.ok) return { configured: false, reason: 'mmp_thresholds_incomplete', detail: openQuotes.detail };
  const windowMs = parseNonNegativeInt(obj, 'observationWindowMs', 'observationWindowMs');
  if (!windowMs.ok) return { configured: false, reason: 'mmp_thresholds_incomplete', detail: windowMs.detail };

  return {
    configured: true,
    thresholds: {
      maxFilledQuantity: quantity.value,
      maxFilledDelta: delta.value,
      maxFilledVega: vega.value,
      maxOpenQuotes: openQuotes.value,
      observationWindowMs: windowMs.value,
    },
  };
}

/**
 * Compare a caller-windowed observation to owner maxima.
 * Missing delta/vega refuse rather than assuming zero exposure.
 */
export function evaluateMmMmpTrigger(
  thresholds: MmMmpThresholds,
  observation: MmMmpObservation,
): MmMmpTriggerEvaluation | { readonly ok: false; readonly reason: 'mmp_observation_incomplete'; readonly detail: string } {
  if (observation.filledDelta === null || Number.isNaN(observation.filledDelta) || !Number.isInteger(observation.filledDelta)) {
    return {
      ok: false,
      reason: 'mmp_observation_incomplete',
      detail: 'filledDelta unknown — refuse rather than assume zero exposure',
    };
  }
  if (observation.filledVega === null || Number.isNaN(observation.filledVega) || !Number.isInteger(observation.filledVega)) {
    return {
      ok: false,
      reason: 'mmp_observation_incomplete',
      detail: 'filledVega unknown — refuse rather than assume zero exposure',
    };
  }
  if (!Number.isInteger(observation.openQuotes) || observation.openQuotes < 0) {
    return {
      ok: false,
      reason: 'mmp_observation_incomplete',
      detail: 'openQuotes must be a non-negative integer — not invented',
    };
  }
  if (observation.filledQuantity < 0n) {
    return {
      ok: false,
      reason: 'mmp_observation_incomplete',
      detail: 'filledQuantity must be a non-negative amount — not invented',
    };
  }

  const reasons: MmMmpTriggerReason[] = [];
  const details: string[] = [];

  if (observation.filledQuantity > thresholds.maxFilledQuantity) {
    reasons.push('filled_quantity');
    details.push('filledQuantity exceeds owner maxFilledQuantity');
  }
  if (Math.abs(observation.filledDelta) > thresholds.maxFilledDelta) {
    reasons.push('filled_delta');
    details.push(`filledDelta ${observation.filledDelta} exceeds owner maxFilledDelta ${thresholds.maxFilledDelta}`);
  }
  if (Math.abs(observation.filledVega) > thresholds.maxFilledVega) {
    reasons.push('filled_vega');
    details.push(`filledVega ${observation.filledVega} exceeds owner maxFilledVega ${thresholds.maxFilledVega}`);
  }
  if (observation.openQuotes > thresholds.maxOpenQuotes) {
    reasons.push('open_quotes');
    details.push(`openQuotes ${observation.openQuotes} exceeds owner maxOpenQuotes ${thresholds.maxOpenQuotes}`);
  }

  if (reasons.length === 0) return { triggered: false };
  return { triggered: true, reasons, detail: details.join('; ') };
}

/** Mass quote, freeze, and reset all refuse when owner MMP thresholds are unset. */
export function runMmMmpAction(
  action: MmMmpAction,
  env: NodeJS.ProcessEnv = process.env,
  observation?: MmMmpObservation,
): MmMmpActionResult {
  const gate = mmMmpThresholdsGate(env);
  if (!gate.configured) {
    return {
      ok: false,
      action,
      reason: gate.reason,
      detail: `${action} disabled — ${gate.detail}`,
    };
  }

  if (observation !== undefined) {
    const trigger = evaluateMmMmpTrigger(gate.thresholds, observation);
    if ('ok' in trigger && trigger.ok === false) {
      return { ok: false, action, reason: trigger.reason, detail: trigger.detail };
    }
    if ('triggered' in trigger && trigger.triggered) {
      if (action === 'mass_quote') {
        return {
          ok: false,
          action,
          reason: 'mmp_triggered',
          detail: `mass quote fenced — ${trigger.detail}`,
        };
      }
      if (action === 'freeze') {
        return { ok: true, action, thresholds: gate.thresholds };
      }
    } else if (action === 'freeze') {
      return {
        ok: false,
        action,
        reason: 'mmp_observation_incomplete',
        detail: 'freeze requires an MMP trigger — thresholds not invented into a freeze',
      };
    }
  } else if (action === 'freeze') {
    return {
      ok: false,
      action,
      reason: 'mmp_observation_incomplete',
      detail: 'freeze requires a caller-windowed MMP observation — window not invented',
    };
  }

  return { ok: true, action, thresholds: gate.thresholds };
}
