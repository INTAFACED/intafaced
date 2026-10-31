import type { QuantSignalRules } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { QUANT_PARAM_OUT_OF_RANGE, QUANT_PARAM_UNSET, QUANT_SIZING_RULE_UNSET, QuantError } from '../errors.js';

/**
 * The no-code builder (AL-editor-02): signal rules are data, compiled here by first-party code into a readable source.
 * Nothing here evaluates text. The backtest engine reads the stored rules, never the source.
 */

/** The history route answers at most 1000 bars a read, so a slower average than that could never warm up. */
export const MAX_AVERAGE_BARS = 1000;

export interface RuleInput {
  readonly name: string;
  readonly type: 'symbol' | 'integer' | 'decimal';
  readonly required: boolean;
  readonly value: string;
  readonly min: string | null;
  readonly max: string | null;
}

export interface CompiledRules {
  readonly rules: QuantSignalRules;
  readonly source: string;
  readonly inputs: readonly RuleInput[];
}

const DECIMAL = /^\d+(\.\d{1,18})?$/;
const INTEGER = /^[1-9]\d{0,5}$/;

function unset(name: string): never {
  throw new QuantError(QUANT_PARAM_UNSET, `${name} is blank; fill it in before the rules run`);
}

function outOfRange(name: string, detail: string): never {
  throw new QuantError(QUANT_PARAM_OUT_OF_RANGE, `${name} ${detail}`);
}

function integerInput(name: string, raw: string, min: number, max: number): number {
  const text = raw.trim();
  if (!text) unset(name);
  if (!INTEGER.test(text)) throw new QuantError('quant.params_invalid', `${name} must be a whole number of bars`);
  const value = Number(text);
  if (value < min || value > max) outOfRange(name, `must be from ${min} to ${max} bars`);
  return value;
}

/** A positive decimal, optionally at most `max`. Blank returns null so the caller decides whether it is required. */
function positiveDecimal(name: string, raw: string, max: string | null): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (!DECIMAL.test(text)) throw new QuantError('quant.params_invalid', `${name} must be a decimal string`);
  let value: bigint;
  try {
    value = parseAmount(text);
  } catch {
    outOfRange(name, 'is larger than an amount can be');
  }
  if (value <= 0n) outOfRange(name, 'must be more than 0');
  if (max !== null && value > parseAmount(max)) outOfRange(name, `must be at most ${max}`);
  return text;
}

/** Sizing bounds: a percent of equity is at most 100; a quantity or cash amount only has to be positive. */
function sizingMax(kind: QuantSignalRules['sizing']['kind']): string | null {
  return kind === 'percent_equity' ? '100' : null;
}

/**
 * Checks every input in the order the builder shows them and names the first blank or out-of-range one. On success
 * the rules come back trimmed with the generated source and the declared inputs.
 */
export function compileSignalRules(input: QuantSignalRules): CompiledRules {
  const symbol = input.symbol.trim();
  if (!symbol) unset('symbol');
  const fast = integerInput('signal.fast', input.signal.fast, 1, MAX_AVERAGE_BARS - 1);
  const slow = integerInput('signal.slow', input.signal.slow, 2, MAX_AVERAGE_BARS);
  if (slow <= fast) outOfRange('signal.slow', 'must be more bars than signal.fast');
  const size = positiveDecimal('sizing.value', input.sizing.value, sizingMax(input.sizing.kind));
  if (size === null) throw new QuantError(QUANT_SIZING_RULE_UNSET, 'sizing.value is blank; the rule never picks a size for you');
  // A long position can lose at most all of it, so a stop beyond 100 percent never fires.
  const stopLoss = positiveDecimal('exit.stopLossPercent', input.exit.stopLossPercent, '100');
  const takeProfit = positiveDecimal('exit.takeProfitPercent', input.exit.takeProfitPercent, null);

  const rules: QuantSignalRules = {
    symbol,
    barSize: input.barSize,
    signal: { kind: 'ma_cross', average: input.signal.average, fast: String(fast), slow: String(slow) },
    sizing: { kind: input.sizing.kind, value: size },
    exit: { stopLossPercent: stopLoss ?? '', takeProfitPercent: takeProfit ?? '' },
  };
  return { rules, source: signalSource(rules), inputs: declaredInputs(rules) };
}

function declaredInputs(rules: QuantSignalRules): RuleInput[] {
  return [
    { name: 'symbol', type: 'symbol', required: true, value: rules.symbol, min: null, max: null },
    { name: 'signal.fast', type: 'integer', required: true, value: rules.signal.fast, min: '1', max: String(MAX_AVERAGE_BARS - 1) },
    { name: 'signal.slow', type: 'integer', required: true, value: rules.signal.slow, min: '2', max: String(MAX_AVERAGE_BARS) },
    { name: 'sizing.value', type: 'decimal', required: true, value: rules.sizing.value, min: null, max: sizingMax(rules.sizing.kind) },
    { name: 'exit.stopLossPercent', type: 'decimal', required: false, value: rules.exit.stopLossPercent, min: null, max: '100' },
    { name: 'exit.takeProfitPercent', type: 'decimal', required: false, value: rules.exit.takeProfitPercent, min: null, max: null },
  ];
}

const SIZE_CALL: Record<QuantSignalRules['sizing']['kind'], string> = {
  quantity: 'size.quantity',
  cash: 'size.cash',
  percent_equity: 'size.percentOfEquity',
};

/** How one number enters the source: a filled rule writes its value; a template writes a named blank. */
type Slot = (name: string, value: string, quoted: boolean) => string;
const filled: Slot = (_name, value, quoted) => (quoted ? JSON.stringify(value) : value);
const blankNamed: Slot = (name, value, quoted) =>
  value === '' ? `/* ${name}: blank, you set it after Use */` : filled(name, value, quoted);

/** The readable source of one rule set. Same rules, same text, byte for byte. */
export function signalSource(rules: QuantSignalRules): string {
  return sourceOf(rules, filled, '// Generated by the no-code builder from your signal rules. Simulated: backtest and paper only.');
}

/**
 * A starter template version's source (AL-editor-03), read only: the same generated source, with every number the
 * template leaves blank written as a named blank, so it reads as what Use will put in the form before you fill it in.
 */
export function templateSource(rules: QuantSignalRules): string {
  const exits = [
    ['exit.stopLossPercent', rules.exit.stopLossPercent],
    ['exit.takeProfitPercent', rules.exit.takeProfitPercent],
  ].filter(([, value]) => value === '');
  const source = sourceOf(rules, blankNamed, '// Starter template source, read only. Simulated: backtest and paper only.');
  if (!exits.length) return source;
  return `${source}\n// Optional, blank in the template: ${exits.map(([name]) => name).join(', ')}.`;
}

function sourceOf(rules: QuantSignalRules, slot: Slot, header: string): string {
  const s = JSON.stringify(rules.symbol);
  const bar = JSON.stringify(rules.barSize);
  const avg = rules.signal.average;
  const lines = [
    header,
    `const closes = bars(${s}, ${bar}).close;`,
    `const fast = ${avg}(closes, ${slot('signal.fast', rules.signal.fast, false)});`,
    `const slow = ${avg}(closes, ${slot('signal.slow', rules.signal.slow, false)});`,
    '',
    'if (crossesAbove(fast, slow) && position(' + s + ').qty == 0) {',
    `  oms.buy(${s}, ${SIZE_CALL[rules.sizing.kind]}(${slot('sizing.value', rules.sizing.value, true)}));`,
    '}',
    'if (crossesBelow(fast, slow) && position(' + s + ').qty > 0) {',
    `  oms.sell(${s}, position(${s}).qty);`,
    '}',
  ];
  if (rules.exit.stopLossPercent) {
    lines.push(`exit.stopLoss(${s}, percent(${slot('exit.stopLossPercent', rules.exit.stopLossPercent, true)}));`);
  }
  if (rules.exit.takeProfitPercent) {
    lines.push(`exit.takeProfit(${s}, percent(${slot('exit.takeProfitPercent', rules.exit.takeProfitPercent, true)}));`);
  }
  return lines.join('\n');
}
