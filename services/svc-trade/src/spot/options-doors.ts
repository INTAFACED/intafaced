import { requireScope, type Principal } from '@intafaced/auth';
import { OPTIONS_FIXING_UNCONFIGURED, OPTIONS_SETTLEMENT_LAW_UNSET } from './options-policy.js';

/**
 * No options position, exercise, or margin model exists. These doors name the
 * blank law or the blank fixing and write nothing. A set law and a set fixing
 * still refuse: the model is the owner's, and this service does not invent one.
 */
export const TRADE_OPTIONS_MODEL_UNSET = 'trade.options_model_unset' as const;

export interface OptionsDoorRefusal {
  readonly refused: true;
  readonly code: typeof OPTIONS_SETTLEMENT_LAW_UNSET | typeof OPTIONS_FIXING_UNCONFIGURED | typeof TRADE_OPTIONS_MODEL_UNSET;
  readonly jobsEnabled?: boolean;
}

export interface OptionsDoorConfig {
  readonly settlementAssetLaw: string;
  readonly settlementFixing: string;
  /** TRADE_OPTIONS_JOBS_ENABLED as the process actually has it. This door does not turn it on. */
  readonly jobsEnabled?: boolean;
}

export function optionsDoorCode(config: OptionsDoorConfig): OptionsDoorRefusal['code'] {
  if (config.settlementAssetLaw.trim().length === 0) return OPTIONS_SETTLEMENT_LAW_UNSET;
  if (config.settlementFixing.trim().length === 0) return OPTIONS_FIXING_UNCONFIGURED;
  return TRADE_OPTIONS_MODEL_UNSET;
}

export function optionsPositions(principal: Principal, config: OptionsDoorConfig): OptionsDoorRefusal {
  requireScope(principal, 'trade:read');
  return { refused: true, code: optionsDoorCode(config) };
}

export function optionsExercises(principal: Principal, config: OptionsDoorConfig): OptionsDoorRefusal {
  requireScope(principal, 'trade:read');
  return { refused: true, code: optionsDoorCode(config), jobsEnabled: config.jobsEnabled === true };
}

export function optionsMarginPreview(principal: Principal, config: OptionsDoorConfig): OptionsDoorRefusal {
  requireScope(principal, 'trade:read');
  return { refused: true, code: optionsDoorCode(config) };
}
