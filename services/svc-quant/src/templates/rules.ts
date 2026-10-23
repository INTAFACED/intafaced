import type { QuantSignalRules } from '@intafaced/contracts';
import { QUANT_TEMPLATE_NUMBER_SET, QuantError } from '../errors.js';

/**
 * A template never carries a number for the person: the averages, the size and the exits stay blank and are filled in
 * after Use. The first number set is refused by name. The symbol, bar size, average and sizing kind are choices, not
 * numbers, and may be set.
 */
export function blankTemplateRules(rules: QuantSignalRules): QuantSignalRules {
  const numbers: [string, string][] = [
    ['signal.fast', rules.signal.fast],
    ['signal.slow', rules.signal.slow],
    ['sizing.value', rules.sizing.value],
    ['exit.stopLossPercent', rules.exit.stopLossPercent],
    ['exit.takeProfitPercent', rules.exit.takeProfitPercent],
  ];
  const set = numbers.find(([, value]) => value.trim() !== '');
  if (set) throw new QuantError(QUANT_TEMPLATE_NUMBER_SET, `${set[0]} is set; a template leaves every number blank`);
  return { ...rules, symbol: rules.symbol.trim() };
}
