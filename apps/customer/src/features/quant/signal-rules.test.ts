import { describe, expect, it } from 'vitest';
import { emptySignalRules, ruleRefusal, signalRulesFilled, trimSignalRules } from './signal-rules';

describe('signal rules in the builder', () => {
  it('starts with every number blank and is not filled until each required input holds something', () => {
    const blank = emptySignalRules();
    expect([blank.signal.fast, blank.signal.slow, blank.sizing.value, blank.exit.stopLossPercent]).toEqual(['', '', '', '']);
    expect(signalRulesFilled(blank)).toBe(false);
    const filled = { ...blank, symbol: 'BTC/USDT', signal: { ...blank.signal, fast: '3', slow: '5' }, sizing: { ...blank.sizing, value: '1' } };
    expect(signalRulesFilled(filled)).toBe(true);
    expect(signalRulesFilled({ ...filled, signal: { ...filled.signal, slow: ' ' } })).toBe(false);
    expect(trimSignalRules({ ...filled, symbol: ' BTC/USDT ' }).symbol).toBe('BTC/USDT');
  });

  it('reads the input a refusal names, and nothing else', () => {
    expect(ruleRefusal('quant.param_unset — signal.slow is blank; fill it in before the rules run')).toEqual({
      kind: 'unset',
      input: 'signal.slow',
      detail: 'is blank; fill it in before the rules run',
    });
    expect(ruleRefusal('quant.param_out_of_range — sizing.value must be at most 100')).toEqual({
      kind: 'outOfRange',
      input: 'sizing.value',
      detail: 'must be at most 100',
    });
    expect(ruleRefusal('quant.sizing_rule_unset — sizing.value is blank; the rule never picks a size for you')?.kind).toBe('sizingUnset');
    expect(ruleRefusal('quant.param_unset — somethingElse is blank')).toBeNull();
    expect(ruleRefusal('quant.cash_unset — cash is unset')).toBeNull();
  });
});
