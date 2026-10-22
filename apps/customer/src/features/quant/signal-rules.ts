import type { QuantSignalRules } from '@intafaced/contracts/quant-algo';

/** A blank set of signal rules: every number empty, so nothing is ever filled in for the person. */
export const emptySignalRules = (): QuantSignalRules => ({
  symbol: '',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '', slow: '' },
  sizing: { kind: 'quantity', value: '' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
});

export const trimSignalRules = (rules: QuantSignalRules): QuantSignalRules => ({
  symbol: rules.symbol.trim(),
  barSize: rules.barSize,
  signal: { ...rules.signal, fast: rules.signal.fast.trim(), slow: rules.signal.slow.trim() },
  sizing: { kind: rules.sizing.kind, value: rules.sizing.value.trim() },
  exit: { stopLossPercent: rules.exit.stopLossPercent.trim(), takeProfitPercent: rules.exit.takeProfitPercent.trim() },
});

/** Whether every required input holds something; the service still checks each value and refuses by name. */
export const signalRulesFilled = (rules: QuantSignalRules): boolean =>
  Boolean(rules.symbol.trim() && rules.signal.fast.trim() && rules.signal.slow.trim() && rules.sizing.value.trim());

export type RuleInputName = 'symbol' | 'signal.fast' | 'signal.slow' | 'sizing.value' | 'exit.stopLossPercent' | 'exit.takeProfitPercent';
const INPUT_NAMES: readonly RuleInputName[] = [
  'symbol',
  'signal.fast',
  'signal.slow',
  'sizing.value',
  'exit.stopLossPercent',
  'exit.takeProfitPercent',
];

export type RuleRefusal = {
  kind: 'unset' | 'outOfRange' | 'sizingUnset';
  input: RuleInputName;
  /** The service's own words for the range, after the input name. */
  detail: string;
};

const REFUSAL = /quant\.(param_unset|param_out_of_range|sizing_rule_unset) — ([a-zA-Z.]+) (.*)$/;

/** Reads which input a builder refusal names. Anything else is not a builder refusal and returns null. */
export function ruleRefusal(message: string): RuleRefusal | null {
  const match = message.match(REFUSAL);
  if (!match) return null;
  const input = INPUT_NAMES.find((name) => name === match[2]);
  if (!input) return null;
  const kind = match[1] === 'param_unset' ? 'unset' : match[1] === 'sizing_rule_unset' ? 'sizingUnset' : 'outOfRange';
  return { kind, input, detail: match[3]!.trim() };
}
